import { nativeContent } from './fixtures/native-content.js';
import { DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { navigationAction, selectEditorSection } from './ui-navigation.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from './fixtures/browser-test.js';
import type { RisuContent } from '../core/risu-content.js';
import type { Content } from '../core/product.js';
import { packageImageThumbnailUrl } from '../core/package-images.js';
import { revealLibraryEditor } from './ui-navigation.js';

async function choosePortraitAction(portrait: Locator, name: string) {
  await portrait.getByLabel('대표 이미지 변경', { exact: true }).click();
  await portrait.getByRole('button', { name, exact: true }).click();
}

const thumbnail = (hash: string) => packageImageThumbnailUrl(`/api/package-image-blobs/${hash}`);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
  'base64'
);
const otherPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPY3RH6HwAGMgKYxcNPSgAAAABJRU5ErkJggg==',
  'base64'
);
type UploadedImage = { hash: string; mime: NonNullable<RisuContent['images']>[number]['mime'] };
async function blob(request: APIRequestContext, bytes = png): Promise<UploadedImage> {
  const response = await request.post('/api/package-image-blobs', {
    data: { mime: 'image/png', base64: bytes.toString('base64') },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seed(
  request: APIRequestContext,
  kind: Content['kind'],
  title: string,
  part: Partial<RisuContent> = {}
): Promise<Content> {
  const pkg = nativeContent(
    {
      name: title,
      creator_notes: '합성 자료 · 이미지와 선택 동작 검사',
      description: 'Synthetic content only.',
    },
    { id: 'synthetic-library-portrait', ...part },
    kind
  );
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function openLibrary(page: Page, kind: Content['kind']) {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await library
    .getByRole('tab', {
      name: { bot: '봇', persona: '페르소나', module: '모듈' }[kind],
      exact: true,
    })
    .click();
  return library;
}
async function edit(page: Page, content: Content) {
  const library = await openLibrary(page, content.kind);
  await library.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(content.title);
  await library.getByRole('button', { name: `${content.title} 편집`, exact: true }).click();
  await revealLibraryEditor(page);
  return library;
}
async function save(page: Page, library: Locator, content: Content): Promise<Content> {
  const pending = waitForContentSave(page, content.id);
  await library.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  return pending;
}
test('LIMG01 representative image upload, unset and existing inline selection preserve current content and its one undo', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const originalHash = await blob(request),
    original = await seed(request, 'persona', `대표 이미지 합성 ${Date.now()}`, {
      images: [
        {
          id: 'inline',
          title: '본문 그림',
          description: '',
          blobHash: originalHash.hash,
          mime: originalHash.mime,
          allowedUse: 'inline',
        },
      ],
    });
  const library = await edit(page, original),
    portrait = library.getByRole('region', { name: '대표 이미지 설정', exact: true });
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: otherPng });
  await expect(portrait.getByRole('status')).toContainText('대표 이미지 전용으로 추가했어요');
  const uploaded = await save(page, library, original),
    profile = uploaded.package!.images!.find(
      (image) => image.id === uploaded.package!.portraitImageId
    )!;
  expect(profile.allowedUse).toBe('profile');
  expect(profile.blobHash).not.toBe(originalHash.hash);
  expect(uploaded.package!.images).toHaveLength(2);
  await expect(portrait.locator('img')).toHaveAttribute('src', thumbnail(profile.blobHash));
  await library.getByRole('button', { name: '서재 목록', exact: true }).click();
  const card = library.getByRole('button', { name: `${original.title} 편집`, exact: true });
  await expect(card.locator('img')).toHaveAttribute('src', thumbnail(profile.blobHash));
  await card.click();
  await revealLibraryEditor(page);
  await choosePortraitAction(portrait, '대표 이미지 해제');
  const unset = await save(page, library, uploaded);
  expect(unset.package!.portraitImageId).toBeUndefined();
  expect(unset.package!.images).toEqual(uploaded.package!.images);
  await expect(portrait.locator('img')).toHaveCount(0);
  await choosePortraitAction(portrait, '기존 이미지에서 선택');
  const picker = page.getByRole('dialog', { name: '대표 이미지 선택', exact: true });
  await picker
    .getByRole('button')
    .filter({ has: page.getByText('본문 그림', { exact: true }) })
    .click();
  await expect(portrait.getByRole('status')).toContainText('대표 이미지와 본문으로 바꿨어요');
  const reused = await save(page, library, unset);
  expect(reused.package!.portraitImageId).toBe('inline');
  expect(reused.package!.images![0].allowedUse).toBe('both');
  await selectEditorSection(page, '에셋');
  await library
    .getByLabel('Risu 이미지 목록', { exact: true })
    .getByRole('button')
    .filter({ has: page.locator(`img[src="/api/package-image-blobs/${originalHash.hash}"]`) })
    .click();
  const portraitHint = library.getByText('현재 대표 이미지는 ‘본문 전용’으로 바꿀 수 없어요.', {
    exact: true,
  });
  await expect(portraitHint).toBeVisible();
  await library
    .getByLabel('Risu 이미지 목록', { exact: true })
    .getByRole('button')
    .filter({ has: page.locator(`img[src="/api/package-image-blobs/${profile.blobHash}"]`) })
    .click();
  await library.getByRole('button', { name: '선택한 에셋 삭제', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: '이 에셋을 자료에서 제거할까요?', exact: true })
    .getByRole('button', { name: '에셋 삭제', exact: true })
    .click();
  const removed = await save(page, library, reused);
  const completion = page.locator('.transient-notice').filter({ hasText: original.title });
  await expect(completion.first()).toBeVisible();
  expect(await completion.count()).toBe(1);
  expect(removed.package!.images).toHaveLength(1);
  expect(removed.package!.portraitImageId).toBe('inline');
  const current = await (await request.get(`/api/content/${removed.id}`)).json();
  expect(current.package).toEqual(removed.package);
});

test('LIMG03 cancelled and failed portrait uploads cannot change a saved draft or leave saving blocked', async ({
  page,
  request,
}) => {
  const original = await seed(request, 'bot', `업로드 취소 합성 ${Date.now()}`);
  const library = await edit(page, original),
    portrait = library.getByRole('region', { name: '대표 이미지 설정', exact: true }),
    saveButton = library.getByRole('button', { name: '변경사항 저장', exact: true });
  await library.getByLabel('카드 설명', { exact: true }).fill('업로드 취소 뒤에도 저장할 설명');
  await expect(saveButton).toBeEnabled();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/package-image-blobs', async (route) => {
    await waiting;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hash: 'c'.repeat(64), mime: 'image/png' }),
      })
      .catch(() => {});
  });
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: png });
  await expect(portrait.getByRole('button', { name: '업로드 취소', exact: true })).toBeVisible();
  await expect(saveButton).toBeDisabled();
  await portrait.getByRole('button', { name: '업로드 취소', exact: true }).click();
  release();
  await expect(saveButton).toBeEnabled();
  await expect(portrait.locator('img')).toHaveCount(0);
  await page.unroute('**/api/package-image-blobs');
  await page.route('**/api/package-image-blobs', (route) =>
    route.fulfill({ status: 503, body: 'synthetic failure' })
  );
  await portrait
    .getByLabel('대표 이미지 업로드', { exact: true })
    .setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: png });
  await expect(portrait.getByRole('alert')).toContainText('503');
  await expect(saveButton).toBeEnabled();
  await expect(portrait.locator('img')).toHaveCount(0);
  const saved: Content = await (
    await request.get(`/api/revisions/content/${original.id}/${original.revision}`)
  ).json();
  expect(saved.package).toEqual(original.package);
  const after = await save(page, library, original);
  expect(after.package?.images ?? []).toEqual([]);
  expect(after.package?.portraitImageId).toBeUndefined();
});
