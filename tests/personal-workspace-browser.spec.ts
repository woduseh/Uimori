import { legacyChatBackupWithBot } from './fixtures/legacy-backup.js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { visualReview } from './fixtures/visual-review.js';

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
    const description = page.getByLabel('카드 설명', { exact: true });
    const originalDescription = await description.inputValue();
    await description.fill(`${originalDescription}\nTemporary edit`);
    await description.fill(originalDescription);
    await page.getByRole('button', { name: '서재 목록', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: '서재 검색', exact: true })).toBeVisible();
    await expect(
      page.getByRole('alertdialog', { name: '미저장 자료 확인', exact: true })
    ).toBeHidden();
    await openEditor(page, original.title);
    await page.getByLabel('Risu 자료 이름', { exact: true }).fill(`${original.title} changed`);
    const saved = await save(page);
    expect(saved.title).toBe(`${original.title} changed`);
    await selectPackageSection(page, '고급 설정');
    await page.getByRole('button', { name: '원문 JSON', exact: true }).click();
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
  await page
    .getByLabel('선택한 에셋', { exact: true })
    .getByLabel('이미지 용도', { exact: true })
    .selectOption('inline');
  const saved = await save(page);
  expect(saved.package.images![0]).toMatchObject({
    title: '우산을 든 유나',
    description: '비 오는 하굣길, 투명 우산과 미소',
    mime: 'image/webp',
    allowedUse: 'inline',
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
    await other.getByLabel('Risu 자료 이름', { exact: true }).fill(savedTitle);
    await expect.poll(storedTitle).toBe(savedTitle);
    await page.getByLabel('Risu 자료 이름', { exact: true }).fill(recoveredTitle);
    await expect.poll(storedTitle).toBe(recoveredTitle);
    await save(other);
    await expect(
      page.getByRole('alert').filter({
        hasText: '저장된 자료가 변경됐어요. 현재 입력은 유지돼요.',
      })
    ).toBeVisible();
    expect(await storedTitle()).toBe(recoveredTitle);
    await page.reload();
    if (!(await page.getByLabel('Risu 자료 이름', { exact: true }).isVisible()))
      await openEditor(page, savedTitle);
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(recoveredTitle);
    await page.screenshot({
      path: info.outputPath('personal-other-tab-recovery-restored.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '편집 취소', exact: true }).click();
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toHaveValue(savedTitle);
    await expect.poll(storedTitle).toBeUndefined();
  } finally {
    await other.close();
  }
});

test('PERSONAL uploaded metadata locks pending fields and retains rejected input', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, { data: { title: `Metadata ${randomUUID()}` } });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: '#6688aa' },
  })
    .png()
    .toBuffer();
  const uploaded = await request.post(`/api/chats/${chat.id}/assets`, {
    data: {
      title: 'Original image',
      description: 'Original description',
      actor: '',
      outfit: '',
      location: '',
      allowedUse: 'both',
      mime: 'image/png',
      base64: image.toString('base64'),
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const asset = await uploaded.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '이미지');
  await page.locator('.chat-settings-image-management > summary').click();
  await page.getByText('이름·설명 편집', { exact: true }).click();
  const title = page.getByLabel('업로드 이미지 이름', { exact: true });
  const description = page.getByLabel('업로드 이미지 설명', { exact: true });
  const submit = page.getByRole('button', { name: '이미지 정보 저장', exact: true });
  await title.fill('Saved image');
  await description.fill('Saved description');
  const path = `**/api/chats/${chat.id}/assets/${asset.id}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(path, async (route) => {
    await held;
    await route.continue();
  });
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/assets/${asset.id}`) && response.request().method() === 'PATCH'
  );
  try {
    await submit.click();
    await expect(title).toBeDisabled();
    await expect(description).toBeDisabled();
    await expect(submit).toBeDisabled();
    const pending = page
      .getByRole('status')
      .filter({ hasText: '이미지 정보를 저장하는 중이에요…' });
    await expect(pending).toBeVisible();
    const indicator = (await pending.locator('svg').boundingBox())!;
    const label = (await pending.locator('p').boundingBox())!;
    expect(indicator.x + indicator.width).toBeLessThan(label.x);
    expect(Math.abs(indicator.y + indicator.height / 2 - label.y - label.height / 2)).toBeLessThan(
      2
    );
    expect((await pending.boundingBox())!.height).toBeLessThan(40);
    await page.screenshot({
      path: info.outputPath('personal-metadata-pending-disabled.png'),
      fullPage: true,
    });
  } finally {
    release();
  }
  const accepted = await response;
  expect(accepted.ok(), await accepted.text()).toBe(true);
  await expect(description).toBeEnabled();
  await expect(title).toHaveValue('Saved image');
  await expect(description).toHaveValue('Saved description');
  await page.unroute(path);
  await page.route(path, (route) =>
    route.fulfill({ status: 409, json: { error: 'REVISION_CONFLICT' } })
  );
  await title.fill('Keep unsaved title');
  await description.fill('Keep unsaved description');
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(title).toBeEnabled();
  await expect(description).toBeEnabled();
  await expect(title).toHaveValue('Keep unsaved title');
  await expect(description).toHaveValue('Keep unsaved description');
  await page.getByText('이름·설명 편집', { exact: true }).click();
  await expect(title).not.toBeVisible();
  await page.getByText('이름·설명 편집', { exact: true }).click();
  await expect(title).toHaveValue('Keep unsaved title');
  await expect(description).toHaveValue('Keep unsaved description');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('personal-metadata-error-retained.png'),
    fullPage: true,
  });
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
    page.getByText('자료 백업 · 1개 자료 · 0개 프리셋 · 0개 이미지', { exact: true })
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

for (const width of [412, 1440]) {
  test(`AUDIT2 dirty prompt tabs clear the actual sticky header after scrolling ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const title = `AUDIT2 prompt heading ${width} ${randomUUID()}`;
    const response = await request.post('/api/prompt-presets', {
      data: {
        title,
        role: 'translation',
        program: nativePrompt('Synthetic header fixture.'),
        values: {},
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await page.goto('/');
    await navigationAction(page, '프롬프트');
    await page.getByLabel('프롬프트 검색', { exact: true }).fill(title);
    await page.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
    const editor = page.getByTestId('prompt-editor');
    await editor.getByLabel('프롬프트 이름', { exact: true }).fill(`${title} edited`);
    await editor.getByRole('tab', { name: '정규식', exact: true }).click();
    const regex = editor.getByRole('region', { name: '정규식 편집기', exact: true });
    await expect(regex.locator('.native-mobile-picker')).toHaveCount(0);
    await expect(
      regex.locator('.native-empty').getByRole('button', { name: '정규식 추가', exact: true })
    ).toBeVisible();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`audit2-prompt-empty-regex-${width}.png`) });
    await editor.getByText('고급 JSON 편집', { exact: true }).click();
    const raw = editor.getByLabel('Risu 정규식 JSON', { exact: true });
    await raw.fill('{unfinished');
    await raw.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await expect
      .poll(() =>
        raw.evaluate((node) => {
          let scrolled = 0;
          for (let parent = node.parentElement; parent; parent = parent.parentElement)
            scrolled = Math.max(scrolled, parent.scrollTop);
          return scrolled;
        })
      )
      .toBeGreaterThan(0);
    const heading = editor.locator(':scope > .prompt-editor-heading');
    const tabs = editor.getByRole('tablist', { name: '프리셋 편집 영역', exact: true });
    await expect
      .poll(async () => {
        const header = (await heading.boundingBox())!;
        const navigation = (await tabs.boundingBox())!;
        return navigation.y - (header.y + header.height);
      })
      .toBeGreaterThanOrEqual(-1);
    // The measured offset must not become the header's minimum and grow on each resize.
    const minimum = await heading.evaluate((node) => getComputedStyle(node).minHeight);
    expect(minimum).toBe(width === 412 ? '64px' : '72px');
    await expect(raw).toHaveValue('{unfinished');
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`audit2-prompt-sticky-header-${width}.png`) });
    await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
    await expect(editor.getByRole('tabpanel', { name: '기본 옵션', exact: true })).toBeVisible();
  });

  test(`AUDIT2 archive import confirms a completed request after a lost response without duplicates ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const title = `AUDIT2 archive ${width} ${randomUUID()}`;
    const original = await createBot(request, title);
    const archive = await request.post('/api/native-transfers/export-archive', {
      data: { items: [{ kind: 'content', id: original.id }] },
    });
    expect(archive.ok(), await archive.text().catch(() => '')).toBe(true);
    const bytes = await archive.body();
    const importedTitleCount = async () => {
      const library = await (await request.get('/api/library?view=summary')).json();
      return library.contents.filter((item: { title: string }) => item.title === title).length;
    };
    const before = await importedTitleCount();
    const bodies: unknown[] = [];
    let receipt: { created: boolean; items: { id: string }[] } | undefined;
    await page.route('**/api/native-transfers/apply-archive', async (route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length !== 1) return route.continue();
      // The server commits and stores its receipt; only the browser-facing response is lost.
      const accepted = await route.fetch();
      expect(accepted.ok(), await accepted.text()).toBe(true);
      receipt = await accepted.json();
      await route.fulfill({ status: 503, json: { error: 'AUDIT2_IMPORT_RESPONSE_LOST' } });
    });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    const importer = page.getByRole('region', { name: '백업 파일 가져오기', exact: true });
    const file = importer.getByLabel('백업 파일 선택', { exact: true });
    await file.setInputFiles({
      name: 'audit2-resource.uimori',
      mimeType: 'application/zip',
      buffer: bytes,
    });
    await expect(importer).toContainText('1개 자료 · 0개 프리셋 · 0개 이미지');
    await importer.getByRole('button', { name: '새 자료로 가져오기', exact: true }).click();
    await expect(importer.getByRole('alert')).toContainText('503');
    expect(receipt?.created).toBe(true);
    expect(await importedTitleCount()).toBe(before + 1);
    await importer.getByRole('alert').scrollIntoViewIfNeeded();
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`audit2-resource-import-uncertain-${width}.png`),
      });
    await expect(file).toBeDisabled();
    await expect(importer.getByRole('status')).toContainText('완료 여부');
    const retry = page.waitForResponse(
      (response) => response.url().endsWith('/api/native-transfers/apply-archive') && response.ok()
    );
    await importer.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }).click();
    const replay = await (await retry).json();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(replay.created).toBe(false);
    expect(replay.items).toEqual(receipt!.items);
    expect(await importedTitleCount()).toBe(before + 1);
    await expect(file).toBeEnabled();
    await expect(importer.getByRole('status')).toContainText('1개 자료를 추가했어요.');
    await expect(importer.getByRole('alert')).toHaveCount(0);
    if (visualReview)
      await page.screenshot({
        path: info.outputPath(`audit2-resource-import-confirmed-${width}.png`),
      });
  });

  for (const kind of ['content', 'prompt'] as const) {
    test(`AUDIT2 ${kind} backup failure stays in the sticky header after its menu closes ${width}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const title = `AUDIT2 ${kind} export ${width} ${randomUUID()}`;
      const endpoint = kind === 'content' ? '/api/content' : '/api/prompt-presets';
      let original: { id: string; title: string };
      if (kind === 'content') original = await createBot(request, title);
      else {
        const response = await request.post(endpoint, {
          data: {
            title,
            role: 'translation',
            program: nativePrompt('Synthetic export fixture.', {}, 'translation'),
            values: {},
          },
        });
        expect(response.ok(), await response.text()).toBe(true);
        original = await response.json();
      }
      const stored = await (await request.get(`${endpoint}/${original.id}`)).json();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const message = '합성 백업 다운로드 응답 실패';
      await page.route('**/api/native-transfers/export-archive', async (route) => {
        started();
        await held;
        await route.fulfill({ status: 503, json: { error: message } });
      });
      try {
        if (kind === 'content') await openEditor(page, original.title);
        else {
          await page.goto('/');
          await navigationAction(page, '프롬프트');
          await page.getByLabel('프롬프트 검색', { exact: true }).fill(original.title);
          await page
            .getByRole('button', { name: `${original.title} 프롬프트 편집`, exact: true })
            .click();
        }
        const editor =
          kind === 'content'
            ? page.locator('.library-content-editor')
            : page.getByTestId('prompt-editor');
        const heading = editor.locator(
          kind === 'content'
            ? ':scope > .library-detail-heading'
            : ':scope > .prompt-editor-heading'
        );
        const menu = heading.locator('details.action-menu');
        await menu
          .getByLabel(kind === 'content' ? '자료 메뉴' : '프롬프트 관리', { exact: true })
          .click();
        await menu.getByRole('button', { name: '자료 백업', exact: true }).click();
        await requested;
        await expect(menu).not.toHaveAttribute('open');
        const failed = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/native-transfers/export-archive') &&
            response.status() === 503
        );
        release();
        await failed;
        const alert = heading.getByRole('alert').filter({ hasText: message });
        await expect(alert).toBeInViewport({ ratio: 1 });
        const close = alert.getByRole('button', { name: '오류 메시지 닫기', exact: true });
        const closeBox = (await close.boundingBox())!;
        const messageBox = (await alert.locator('.notice-banner-message').boundingBox())!;
        expect(closeBox.x).toBeGreaterThanOrEqual(messageBox.x + messageBox.width - 1);
        expect(
          Math.abs(closeBox.y + closeBox.height / 2 - messageBox.y - messageBox.height / 2)
        ).toBeLessThanOrEqual(2);
        const tabs = editor.getByRole('tablist', {
          name: kind === 'content' ? '자료 편집 영역' : '프리셋 편집 영역',
          exact: true,
        });
        const clearHeader = async () => {
          const header = (await heading.boundingBox())!;
          const navigation = (await tabs.boundingBox())!;
          return navigation.y - (header.y + header.height);
        };
        await expect.poll(clearHeader).toBeGreaterThanOrEqual(-1);
        await expect(menu).not.toHaveAttribute('open');
        await expect(
          editor.getByLabel(kind === 'content' ? 'Risu 자료 이름' : '프롬프트 이름', {
            exact: true,
          })
        ).toHaveValue(original.title);
        expect(await (await request.get(`${endpoint}/${original.id}`)).json()).toEqual(stored);
        if (visualReview)
          await page.screenshot({
            path: info.outputPath(`audit2-${kind}-export-late-failed-${width}.png`),
          });
        const expanded = (await heading.boundingBox())!.height;
        await alert.getByRole('button', { name: '오류 메시지 닫기', exact: true }).click();
        await expect(alert).toBeHidden();
        await expect.poll(async () => (await heading.boundingBox())!.height).toBeLessThan(expanded);
        await expect.poll(clearHeader).toBeGreaterThanOrEqual(-1);
      } finally {
        release();
      }
    });
  }
}
