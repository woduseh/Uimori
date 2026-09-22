import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { navigationAction } from './ui-navigation.js';

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
  await page.getByRole('button', { name: `${title} 상세 보기`, exact: true }).click();
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toBeVisible();
}
async function selectPackageSection(page: Page, name: string) {
  const navigation = page.getByLabel('자료 편집 영역', { exact: true });
  await navigation
    .getByRole('tab', { name, exact: true })
    .or(navigation.getByRole('button', { name, exact: true }))
    .click();
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

for (const width of [1440, 412]) {
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
    await page.getByLabel('Risu 자료 이름', { exact: true }).fill(`${original.title} changed`);
    const saved = await save(page);
    expect(saved.title).toBe(`${original.title} changed`);
    await selectPackageSection(page, '고급 설정');
    await page.getByRole('button', { name: '원문', exact: true }).click();
    await page.getByLabel('Risu 원문 편집 대상', { exact: true }).selectOption('card');
    const raw = page.getByLabel('Risu 원문 JSON', { exact: true });
    const card = JSON.parse(await raw.inputValue());
    card.description = 'Saved from raw JSON with no apply step.';
    await raw.fill(JSON.stringify(card, null, 2));
    expect((await save(page)).text).toBe(card.description);
    await selectPackageSection(page, '기본 정보');
    await page.getByLabel('Risu 자료 이름', { exact: true }).fill('Recovered local input');
    // The compact header hides this secondary hint; persistence is verified by reload below.
    await expect(page.getByText('이 기기에 복구용 입력 보관됨', { exact: true })).toBeAttached();
    await page.reload();
    // Navigation state need not persist; the resource's per-device input does.
    if (!(await page.getByLabel('Risu 자료 이름', { exact: true }).isVisible()))
      await openEditor(page, saved.title);
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(
      'Recovered local input'
    );
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(saved.title);
    expect((await (await request.get(`/api/content/${saved.id}`)).json()).title).toBe(saved.title);
    expect(paths.some((path) => path.includes('edit-draft'))).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`personal-editor-${width}.png`),
      fullPage: true,
    });
  });
}

test('PERSONAL images retain native alias while display metadata and WebP persist', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const original = await createBot(request, `Image metadata ${randomUUID()}`);
  await openEditor(page, original.title);
  await selectPackageSection(page, '에셋');
  const image = await sharp({
    create: {
      width: 96,
      height: 72,
      channels: 4,
      background: { r: 60, g: 120, b: 190, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  await page
    .getByLabel('Risu 이미지 추가', { exact: true })
    .setInputFiles({ name: 'script_alias.png', mimeType: 'image/png', buffer: image });
  await page.getByLabel('Risu 이미지 목록', { exact: true }).getByRole('button').first().click();
  await page.getByLabel('이미지 이름', { exact: true }).fill('우산을 든 유나');
  await page.getByLabel('이미지 설명', { exact: true }).fill('비 오는 하굣길, 투명 우산과 미소');
  const saved = await save(page);
  expect(saved.package.images![0]).toMatchObject({
    title: '우산을 든 유나',
    description: '비 오는 하굣길, 투명 우산과 미소',
    mime: 'image/webp',
  });
  expect(saved.package.nativeRisu.assets[0].name).toBe('script_alias');
  const response = await request.get(
    `/api/package-image-blobs/${saved.package.images![0].blobHash}`
  );
  const metadata = await sharp(await response.body()).metadata();
  expect([metadata.format, metadata.width, metadata.height, metadata.hasAlpha]).toEqual([
    'webp',
    96,
    72,
    true,
  ]);
  await page.getByLabel('Risu 이미지 목록', { exact: true }).getByRole('button').first().click();
  await page.screenshot({ path: info.outputPath('personal-image-metadata.png'), fullPage: true });
});

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
  await page.getByRole('tab', { name: '프로바이더·모델', exact: true }).click();
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

test('PERSONAL chat backup UI imports independent continuing copies', async ({ page, request }) => {
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
  const backupResponse = await request.get(`/api/chats/${original.id}/backup`);
  expect(backupResponse.ok(), await backupResponse.text()).toBe(true);
  const backup = await backupResponse.body();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await page.getByRole('tab', { name: '데이터 관리', exact: true }).click();
  const input = page.getByLabel('채팅 백업 파일 선택', { exact: true });
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
});
