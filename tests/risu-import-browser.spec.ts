import { expect, test } from '@playwright/test';
import { crc32 } from 'node:zlib';
import type { RisuImportApply, RisuImportResult } from '../core/risu-import.js';
import { navigationAction } from './ui-navigation.js';

function card(title: string) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: title,
      description: 'Synthetic reusable setting',
      first_mes: 'A synthetic opening.',
      character_book: {
        entries: [{ name: 'World', content: 'The sky is green.', constant: true, enabled: true }],
      },
    },
  };
}

// One stored ZIP entry, generated entirely from synthetic fixture content.
function charx(document: unknown) {
  const name = Buffer.from('card.json');
  const bytes = Buffer.from(JSON.stringify(document));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(crc32(bytes), 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(header.length + name.length + bytes.length, 16);
  return Buffer.concat([header, name, bytes, central, name, end]);
}

for (const format of ['charx', 'json'] as const) {
  test(`RISUKINDUI01 imports a ${format} card as a module from the module library without a chat`, async ({
    page,
    request,
  }) => {
    const title = `RISUKINDUI01 ${format} ${Date.now()}`;
    const before = await (await request.get('/api/chats')).json();
    await page.goto('/');
    await navigationAction(page, '모듈');
    await page.getByRole('button', { name: '자료 가져오기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
    await expect(
      dialog.getByRole('combobox', { name: '가져올 자료 종류', exact: true })
    ).toHaveValue('module');
    await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
      name: `synthetic.${format}`,
      mimeType: format === 'charx' ? 'application/zip' : 'application/json',
      buffer: format === 'charx' ? charx(card(title)) : Buffer.from(JSON.stringify(card(title))),
    });
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(dialog.locator('.risu-import-memory')).toHaveCount(0);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    const pending = page.waitForResponse((response) =>
      response.url().endsWith('/api/risu-imports/apply')
    );
    await dialog.getByRole('button', { name: '모듈 가져오기', exact: true }).click();
    const response = await pending;
    expect(response.ok(), await response.text()).toBe(true);
    const imported = (await response.json()) as RisuImportResult;
    expect(imported.chat).toBeNull();
    expect(imported.receipt.items.find((item) => item.root)?.category).toBe('module');
    expect(response.request().postDataJSON()).toMatchObject({ kind: 'module' });
    expect(response.request().postDataJSON()).not.toHaveProperty('memoryIds');
    const content = await (
      await request.get(`/api/content/${imported.receipt.items.find((item) => item.root)!.id}`)
    ).json();
    expect(content.package.lore).toHaveLength(1);
    expect(content.package.lore[0].text).toBe('The sky is green.');
    await expect(dialog.getByText('모듈을 서재에 등록했어요.', { exact: false })).toBeVisible();
    expect(await (await request.get('/api/chats')).json()).toHaveLength(before.length);
  });
}

test('RISUKINDUI02 failed kind changes preserve review and uncertain saves keep the exact request across tabs', async ({
  page,
  request,
}) => {
  const title = `RISUKINDUI02 ${Date.now()}`;
  let rejectKind = false;
  await page.route('**/api/risu-imports/prepare', async (route) => {
    if (rejectKind)
      await route.fulfill({ status: 400, json: { error: 'Synthetic conversion failure' } });
    else await route.continue();
  });
  const submissions: RisuImportApply[] = [];
  let saved: RisuImportResult | undefined;
  await page.route('**/api/risu-imports/apply', async (route) => {
    submissions.push(route.request().postDataJSON() as RisuImportApply);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    saved = (await response.json()) as RisuImportResult;
    if (submissions.length === 1)
      await route.fulfill({ status: 503, json: { error: 'Synthetic lost response' } });
    else await route.fulfill({ response });
  });
  await page.goto('/');
  await navigationAction(page, '서재');
  const trigger = page.getByRole('button', { name: '자료 가져오기', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
  const initialKind = dialog.getByRole('combobox', { name: '가져올 자료 종류', exact: true });
  await expect(initialKind).toHaveValue('');
  await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
    name: 'synthetic.charx',
    mimeType: 'application/zip',
    buffer: charx(card(title)),
  });
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await dialog.getByText('로어 미리보기 (1개)', { exact: true }).click();
  await dialog.locator('.risu-import-lore-entry > summary').click();
  await expect(dialog.getByText('The sky is green.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  const revealKind = async () => {
    const processing = dialog.locator('.risu-import-processing');
    if ((await processing.getAttribute('open')) === null)
      await processing.locator('summary').click();
    return processing.getByRole('combobox', { name: '자료 종류', exact: true });
  };
  rejectKind = true;
  await (await revealKind()).selectOption('module');
  await expect(dialog.getByRole('alert')).toContainText('자료 종류는 유지했어요');
  await expect(await revealKind()).toHaveValue('');
  await expect(dialog.getByText('The sky is green.', { exact: true })).toBeVisible();
  rejectKind = false;
  await (await revealKind()).selectOption('module');
  await expect(await revealKind()).toHaveValue('module');
  await expect(dialog.locator('.risu-import-memory')).toHaveCount(0);
  await (await revealKind()).selectOption('bot');
  await expect(await revealKind()).toHaveValue('bot');
  await dialog.getByText('로어 미리보기 (1개)', { exact: true }).click();
  await dialog.locator('.risu-import-lore-entry > summary').click();
  await expect(dialog.getByText('The sky is green.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '같은 요청으로 다시 확인' })).toBeVisible();
  await expect(await revealKind()).toBeDisabled();
  await expect(dialog.getByLabel('Risu 파일 선택', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '자료 가져오기 닫기', exact: true }).click();
  await page.getByTestId('library-panel').getByRole('tab', { name: '모듈', exact: true }).click();
  await trigger.click();
  await expect(await revealKind()).toHaveValue('bot');
  await expect(await revealKind()).toBeDisabled();
  await dialog.getByRole('button', { name: '같은 요청으로 다시 확인' }).click();
  await expect(dialog).not.toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]).toMatchObject({ kind: 'bot' });
  expect(submissions[0]).not.toHaveProperty('memoryIds');
  expect(saved?.chat).toBeTruthy();
  const chats = (await (await request.get('/api/chats')).json()) as { id: string }[];
  expect(chats.filter((chat) => chat.id === saved?.chat?.id)).toHaveLength(1);
});
