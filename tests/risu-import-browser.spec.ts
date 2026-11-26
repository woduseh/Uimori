import { expect, test } from '@playwright/test';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import type { RisuImportApply, RisuImportResult } from '../core/risu-import.js';
import { navigationAction } from './ui-navigation.js';

function textChunk(key: string, value: string) {
  const payload = Buffer.concat([Buffer.from(`${key}\0`), Buffer.from(value)]);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write('tEXt', 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

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
  await expect(
    dialog.getByRole('checkbox', { name: '가져온 뒤 새 채팅도 만들기' })
  ).not.toBeChecked();
  const revealKind = async () => dialog.getByRole('combobox', { name: '자료 종류', exact: true });
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
  await dialog.getByRole('checkbox', { name: '가져온 뒤 새 채팅도 만들기' }).check();
  await dialog.getByRole('button', { name: '가져오고 새 채팅 열기', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '같은 요청으로 다시 확인' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '가져오지 않고 닫기' })).toBeDisabled();
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
test('RISUFORMATUI01 imports a v3 png with a reviewed preparation', async ({ page, request }) => {
  const title = `v3 png ${crypto.randomUUID()}`;
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#356789' } })
    .png()
    .toBuffer();
  const document = {
    ...card(title),
    data: {
      ...card(title).data,
      assets: [{ name: 'main', type: 'icon', ext: 'png', uri: 'ccdefault:' }],
    },
  };
  await page.goto('/');
  await navigationAction(page, '서재');
  await page.getByRole('button', { name: '자료 가져오기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자료 가져오기', exact: true });
  const preparation = page.waitForResponse((response) =>
    response.url().endsWith('/api/risu-imports/prepare')
  );
  await dialog.getByLabel('Risu 파일 선택', { exact: true }).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      png.subarray(0, -12),
      textChunk('ccv3', Buffer.from(JSON.stringify(document)).toString('base64')),
      png.subarray(-12),
    ]),
  });
  const preview = await (await preparation).json();
  expect(preview.summary.images).toBe(1);
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const registered = page.waitForResponse((response) =>
    response.url().endsWith('/api/risu-imports/apply')
  );
  await dialog.getByRole('button', { name: '봇 가져오기', exact: true }).click();
  const response = await registered;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON().preparedId).toBe(preview.preparedId);
  const result = await response.json();
  const content = await (
    await request.get(
      `/api/content/${result.receipt.items.find((item: { root: boolean }) => item.root).id}`
    )
  ).json();
  expect(content.package.images).toHaveLength(1);
  expect(content.package.nativeRisu.card.assets[0]).toMatchObject({ name: 'main', type: 'icon' });
  expect(
    (await request.get(`/api/package-image-blobs/${content.package.images[0].blobHash}`)).ok()
  ).toBe(true);
});
