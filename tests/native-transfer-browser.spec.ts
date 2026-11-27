import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Content } from '../core/product.js';
import type { RisuImportResult } from '../core/risu-import.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { navigationAction } from './ui-navigation.js';

async function openImport(page: Page, tab: '봇' | '페르소나' | '모듈') {
  await navigationAction(page, tab);
  const trigger = page.getByRole('button', { name: '자료 가져오기', exact: true });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('가져올 자료 종류')).toHaveValue(
    tab === '봇' ? '' : tab === '페르소나' ? 'persona' : 'module'
  );
  return dialog;
}

async function savedRoot(request: APIRequestContext, result: RisuImportResult) {
  const root = result.receipt.items.find((item) => item.root)!;
  return (await (await request.get(`/api/content/${root.id}`)).json()) as Content;
}

test('NATIVEUI03 imports and exports a standalone Risu module', async ({ page, request }) => {
  const title = `NATIVEUI03 ${Date.now()}`;
  const beforeChats = await (await request.get('/api/chats')).json();
  const source = {
    type: 'risuModule',
    module: {
      id: 'synthetic-module',
      name: title,
      description: 'Synthetic module description.',
      lorebook: [
        {
          key: '',
          comment: 'Harbor setting',
          content: 'The harbor has blue lights.',
          mode: 'normal',
          alwaysActive: true,
          insertorder: 100,
        },
      ],
      regex: [],
      trigger: [],
    },
  };
  await page.goto('/');
  const dialog = await openImport(page, '모듈');
  await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic-risu-module.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  const applied = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/risu-imports/apply') && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '모듈 가져오기', exact: true }).click();
  const result = (await (await applied).json()) as RisuImportResult;
  expect(result.chat).toBeNull();
  expect((await savedRoot(request, result)).kind).toBe('module');
  expect(await (await request.get('/api/chats')).json()).toHaveLength(beforeChats.length);
  await dialog.getByRole('button', { name: '자료 가져오기 닫기', exact: true }).click();
  await page.getByRole('button', { name: `${title} 편집`, exact: true }).click();
  await page.locator('summary').filter({ hasText: '자료 메뉴' }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'RISUM 내보내기', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`${title}.risum`);
  const bytes = await readFile((await download.path())!);
  const decoded = readCharacterCard({
    name: download.suggestedFilename(),
    base64: bytes.toString('base64'),
  });
  expect((decoded.nativeModule as Record<string, unknown>).name).toBe(title);
});
