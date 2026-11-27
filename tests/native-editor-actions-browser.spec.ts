import { expect, test, type APIRequestContext } from './fixtures/browser-test.js';
import type { Content } from '../core/product.js';
import { MOBILE_HEIGHT, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { nativeContent } from './fixtures/native-content.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import { editLibraryContent, navigationAction, selectEditorSection } from './ui-navigation.js';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

{
  const viewport = { name: 'mobile', width: MOBILE_WIDTH, height: MOBILE_HEIGHT };
  test(`NATIVEACTIONS asset removal preserves metadata drafts until parent save on ${viewport.name}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const image = await post<{ hash: string; mime: 'image/png' }>(
      request,
      '/api/package-image-blobs',
      {
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
      }
    );
    const removedTitle = `${'긴에셋이름'.repeat(10)} https://example.test/${'longsegment'.repeat(7)}`;
    const pkg = nativeContent(
      { name: `Asset actions ${crypto.randomUUID()}` },
      {
        images: ['keep', 'remove'].map((id) => ({
          id,
          title: id === 'keep' ? '유지할 이미지' : removedTitle,
          description: '',
          blobHash: image.hash,
          mime: image.mime,
          allowedUse: 'inline',
        })),
      }
    );
    const content = await post<Content>(request, '/api/content', {
      kind: 'bot',
      title: pkg.title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    });
    await page.goto('/');
    await navigationAction(page, '서재');
    await editLibraryContent(page, content.title);
    const save = page.getByRole('button', { name: '변경사항 저장', exact: true });
    await selectEditorSection(page, '에셋');
    const library = page.getByTestId('library-panel');
    const images = library.getByLabel('Risu 이미지 목록', { exact: true });
    await images.getByRole('button', { name: '유지할 이미지', exact: true }).click();
    await library.getByLabel('이미지 설명', { exact: true }).fill('취소와 제거 후에도 유지할 설명');
    const sheet = page.getByRole('dialog', { name: '유지할 이미지', exact: true });
    if (await sheet.isVisible()) {
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
    await images.getByRole('button', { name: removedTitle, exact: true }).click();
    const removeButton = library.getByRole('button', { name: '선택한 에셋 삭제', exact: true });
    const dialog = page.getByRole('alertdialog', {
      name: '이 에셋을 자료에서 제거할까요?',
      exact: true,
    });
    await removeButton.click();
    await expect(dialog).toContainText('원본 파일은 삭제하지 않아요.');
    const description = dialog.locator('.dialog-body > p').first();
    await expect(description).toContainText(removedTitle);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(removeButton).toBeFocused();
    await expect(images.locator('.native-assets-tile-select')).toHaveCount(2);
    await expect(library.getByLabel('이미지 이름', { exact: true })).toHaveValue(removedTitle);
    await removeButton.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(images.locator('.native-assets-tile-select')).toHaveCount(2);
    await removeButton.click();
    await dialog.getByRole('button', { name: '에셋 삭제', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(images.locator('.native-assets-tile-select')).toHaveCount(1);
    await expect(
      library.getByRole('status').filter({ hasText: '자료에서 제거했어요.' })
    ).toBeVisible();
    await images.getByRole('button', { name: '유지할 이미지', exact: true }).click();
    await expect(library.getByLabel('이미지 설명', { exact: true })).toHaveValue(
      '취소와 제거 후에도 유지할 설명'
    );
    const stored = (await (await request.get(`/api/content/${content.id}`)).json()) as Content;
    expect(stored.package!.images).toEqual(content.package!.images);
    if (await sheet.isVisible()) {
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
    const savedResponse = waitForContentSave(page, content.id);
    await save.click();
    const saved = await savedResponse;
    expect(saved.package!.images).toMatchObject([
      { id: 'keep', description: '취소와 제거 후에도 유지할 설명' },
    ]);
    expect(saved.package!.images).toHaveLength(1);
    expect(saved.package!.images![0]!.blobHash).toBe(image.hash);
  });
}
