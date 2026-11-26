import { legacyChatBackupWithBot } from './fixtures/legacy-backup.js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  navigationAction,
  selectSettingsSection,
  selectEditorSection,
  discardEdits,
} from './ui-navigation.js';
import { codeFieldValue } from './code-field.js';

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

for (const width of [412]) {
  test(`PERSONAL ordinary save, raw JSON, recovery and cancel ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const original = await createBot(request, `Personal ${width} ${randomUUID()}`);
    const paths: string[] = [],
      errors: string[] = [];
    page.on('request', (req) => paths.push(new URL(req.url()).pathname));
    page.on('pageerror', (error) => errors.push(error.message));
    await openEditor(page, original.title);
    const description = page.getByLabel('카드 설명', { exact: true });
    const originalDescription = await codeFieldValue(description);
    await description.fill(`${originalDescription}\nTemporary edit`);
    await description.fill(originalDescription);
    await page.getByRole('button', { name: '서재 목록', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: '서재 검색', exact: true })).toBeVisible();
    await expect(
      page.getByRole('alertdialog', { name: '미저장 자료 확인', exact: true })
    ).toBeHidden();
    await openEditor(page, original.title);
    await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).fill(`${original.title} changed`);
    const saved = await save(page);
    expect(saved.title).toBe(`${original.title} changed`);
    await selectEditorSection(page, 'JSON 소스');
    await page.getByLabel('Risu 원문 편집 대상', { exact: true }).selectOption('card');
    const raw = page.getByLabel('Risu 원문 JSON', { exact: true });
    const card = JSON.parse(await raw.inputValue());
    card.description = 'Saved from raw JSON with no apply step.';
    await raw.fill(JSON.stringify(card, null, 2));
    expect((await save(page)).text).toBe(card.description);
    await selectEditorSection(page, '기본 정보');
    await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).fill('Recovered local input');
    await expect
      .poll(() =>
        page.evaluate(async (text) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('uimori-editor-recovery', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise<boolean>((resolve, reject) => {
              const request = db.transaction('buffers').objectStore('buffers').getAll();
              request.onsuccess = () => resolve(JSON.stringify(request.result).includes(text));
              request.onerror = () => reject(request.error);
            });
          } finally {
            db.close();
          }
        }, 'Recovered local input')
      )
      .toBe(true);
    await page.reload();
    if (!(await page.getByLabel(/^(봇|페르소나|모듈) 이름$/u).isVisible()))
      await openEditor(page, saved.title);
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(
      'Recovered local input'
    );
    await discardEdits(page);
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(saved.title);
    expect((await (await request.get(`/api/content/${saved.id}`)).json()).title).toBe(saved.title);
    expect(paths.some((path) => path.includes('edit-draft'))).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`personal-editor-${width}.png`),
      fullPage: true,
    });
  });
}

test('PERSONAL UI accepts a direct API key for a custom LAN endpoint without restart', async ({
  page,
  request,
}, info) => {
  const title = `Provider ${randomUUID()}`;
  const created = await request.post('/api/connections', {
    data: {
      title,
      protocol: 'openai-chat-v1',
      endpoint: 'http://192.168.1.22:8000/v1',
      enabled: true,
    },
  });
  expect(created.ok()).toBe(true);
  const connection = await created.json();
  const key = 'synthetic-browser-secret';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await page.getByRole('tab', { name: '프로바이더와 모델', exact: true }).click();
  await page.getByRole('button', { name: '프로바이더 관리', exact: true }).click();
  await page.getByRole('button', { name: `${title} 프로바이더 수정`, exact: true }).click();
  await page.getByLabel('API 키', { exact: true }).fill(key);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/connections/${connection.id}`) &&
      response.request().method() === 'PUT'
  );
  await page.getByRole('button', { name: '프로바이더 변경 저장', exact: true }).click();
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(await saved.text()).not.toContain(key);
  const current = await (await request.get('/api/library')).json();
  expect(
    current.connections.find((item: { id: string }) => item.id === connection.id).credentialRef
  ).toBeTruthy();
  expect(JSON.stringify(current)).not.toContain(key);
  await page.screenshot({ path: info.outputPath('personal-provider.png'), fullPage: true });
});

test('PERSONAL chat backup rejects malformed previews then imports independent continuing copies', async ({
  page,
  request,
}, info) => {
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
  await page.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('personal-backup-inline-error.png'),
    fullPage: true,
  });
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
}, info) => {
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
    await page.screenshot({
      path: info.outputPath('personal-other-tab-recovery-restored.png'),
      fullPage: true,
    });
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
