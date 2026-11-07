import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Content, PromptPreset } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { createAgentCollaboration, createAgentDefinition } from '../core/agent-collaboration.js';
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  MOBILE_HEIGHT,
  MOBILE_WIDTH,
} from './fixtures/browser-viewports.js';
import { nativeContent } from './fixtures/native-content.js';
import { waitForContentSave, waitForResourceSave } from './fixtures/resource-save.js';
import { editLibraryContent, navigationAction, selectPackageSection } from './ui-navigation.js';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function openPrompt(page: Page, preset: PromptPreset) {
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  await page.getByLabel('프롬프트 검색', { exact: true }).fill(preset.title);
  await page.getByRole('button', { name: `${preset.title} 프롬프트 편집`, exact: true }).click();
  return page.getByTestId('prompt-editor');
}

/** A visible SVG can still be clipped to 1px by a parent, so compare its paintable area. */
async function expectVisibleSaveIcon(button: Locator) {
  const icon = button.locator('svg');
  await expect(icon).toBeVisible();
  const visible = await icon.evaluate((node) => {
    const box = node.getBoundingClientRect();
    let left = box.left;
    let right = box.right;
    let top = box.top;
    let bottom = box.bottom;
    for (
      let parent = node.parentElement;
      parent && parent.tagName !== 'BUTTON';
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return { width: 0, height: 0 };
      const bounds = parent.getBoundingClientRect();
      if (style.overflowX !== 'visible' || style.clipPath !== 'none') {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (style.overflowY !== 'visible' || style.clipPath !== 'none') {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  });
  expect(visible.width).toBeGreaterThanOrEqual(16);
  expect(visible.height).toBeGreaterThanOrEqual(16);
}

async function actionPair(dialog: Locator, confirmName: string, emphasis: 'primary' | 'delete') {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const actions = dialog.locator('.form-actions');
  const cancel = actions.getByRole('button', { name: '취소', exact: true });
  const confirm = actions.getByRole('button', { name: confirmName, exact: true });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  await expect(confirm).toHaveClass(
    new RegExp(emphasis === 'delete' ? 'delete-button' : 'primary')
  );
  const layout = await actions.evaluate((node) => {
    const row = node.getBoundingClientRect();
    const buttons = [...node.querySelectorAll('button')];
    const [first, last] = buttons.map((button) => button.getBoundingClientRect());
    const [cancelStyle, confirmStyle] = buttons.map((button) => getComputedStyle(button));
    return {
      gap: last!.left - first!.right,
      trailingGap: row.right - last!.right,
      topDifference: last!.top - first!.top,
      sizes: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
      cancelBackground: cancelStyle!.backgroundColor,
      confirmBackground: confirmStyle!.backgroundColor,
      cancelColor: cancelStyle!.color,
      confirmColor: confirmStyle!.color,
    };
  });
  expect(layout.gap).toBeGreaterThanOrEqual(7);
  expect(layout.gap).toBeLessThanOrEqual(12);
  expect(Math.abs(layout.trailingGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.topDifference)).toBeLessThanOrEqual(1);
  for (const size of layout.sizes) {
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  expect(layout.confirmBackground).not.toBe(layout.cancelBackground);
  expect(layout.confirmColor).not.toBe(layout.cancelColor);
  expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
}

for (const viewport of [
  { name: 'mobile', width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
  { name: 'desktop', width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
]) {
  test(`NATIVEACTIONS toggle add, rename and confirmation retain drafts on ${viewport.name}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const program = createDefaultRisuPrompt('Synthetic toggle action fixture.');
    const longLabel = '긴 이름과 설명을 충분히 읽을 수 있는 합성 설정';
    const original = `=기존 그룹=group\nkeep=보존할 입력=text\nlong=${longLabel}=text\n==groupEnd`;
    program.nativeRisuPreset.preset.customPromptTemplateToggle = original;
    const preset = await post<PromptPreset>(request, '/api/prompt-presets', {
      title: `Toggle actions ${crypto.randomUUID()}`,
      role: 'main',
      program,
    });
    const editor = await openPrompt(page, preset);
    await editor.getByRole('tab', { name: '변수와 토글', exact: true }).click();
    const definitions = editor.getByRole('region', { name: '토글 정의 편집기', exact: true });
    if (viewport.name === 'mobile') {
      for (const width of [320, MOBILE_WIDTH]) {
        await page.setViewportSize({ width, height: MOBILE_HEIGHT });
        const save = editor.getByRole('button', { name: '프롬프트 저장', exact: true });
        await expectVisibleSaveIcon(save);
        for (const name of ['토글 구성', '기본 변수', '편집', '미리보기', '소스']) {
          const box = await definitions.getByRole('button', { name, exact: true }).boundingBox();
          expect(box).not.toBeNull();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(1);
      }
      await page.setViewportSize({ width: 320, height: MOBILE_HEIGHT });
      await page.evaluate(() => {
        localStorage.setItem('uimori:ui-language', 'en');
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'uimori:ui-language', newValue: 'en' })
        );
      });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      const row = editor.locator('.native-toggle-editor .nt-item').filter({ hasText: longLabel });
      const title = row.locator('.nt-item-copy strong');
      const kind = row.locator('.nt-kind');
      const main = row.locator('.nt-row-main');
      const menu = row.locator('.nt-row > .action-menu');
      await expect(title).toBeVisible();
      await expect(kind).toHaveText('Single-line input');
      expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(90);
      expect(
        await title.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      expect(
        await kind.evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1);
      await main.click();
      await expect(main).toHaveAttribute('aria-expanded', 'true');
      await main.click();
      await menu.locator('summary').click();
      await expect(menu.locator('.action-menu-body button').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).not.toHaveAttribute('open', '');
      await page.evaluate(() => {
        localStorage.setItem('uimori:ui-language', 'ko');
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'uimori:ui-language', newValue: 'ko' })
        );
      });
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await page.setViewportSize(viewport);
    }
    const add = definitions
      .getByRole('button', { name: '그룹 추가', exact: true })
      .filter({ visible: true });
    const addDialog = page.getByRole('dialog', { name: '그룹 추가', exact: true });
    await add.click();
    await expect(addDialog.getByRole('button', { name: '적용', exact: true })).toBeDisabled();
    await addDialog.getByLabel('그룹 이름', { exact: true }).fill('취소할 그룹');
    await actionPair(addDialog, '적용', 'primary');
    await page.screenshot({ path: info.outputPath(`toggle-group-add-${viewport.name}.png`) });
    await addDialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(addDialog).toBeHidden();
    await expect(add).toBeFocused();
    await expect(editor.getByRole('button', { name: '프롬프트 저장', exact: true })).toBeDisabled();
    await add.click();
    await expect(addDialog.getByLabel('그룹 이름', { exact: true })).toHaveValue('');
    await addDialog.getByLabel('그룹 이름', { exact: true }).fill('초안 그룹');
    await addDialog.getByRole('button', { name: '적용', exact: true }).click();
    await expect(addDialog).toBeHidden();
    await expect(
      definitions.getByRole('heading', { name: '초안 그룹', exact: true })
    ).toBeVisible();

    const groupMenu = definitions.getByLabel('그룹 메뉴', { exact: true });
    const renameDialog = page.getByRole('dialog', { name: '그룹 이름 변경', exact: true });
    await groupMenu.click();
    await definitions.getByRole('button', { name: '이름 변경', exact: true }).click();
    await renameDialog.getByLabel('그룹 이름', { exact: true }).fill('취소할 이름');
    await actionPair(renameDialog, '적용', 'primary');
    await renameDialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(
      definitions.getByRole('heading', { name: '초안 그룹', exact: true })
    ).toBeVisible();
    await groupMenu.click();
    await definitions.getByRole('button', { name: '이름 변경', exact: true }).click();
    await expect(renameDialog.getByLabel('그룹 이름', { exact: true })).toHaveValue('초안 그룹');
    await renameDialog.getByLabel('그룹 이름', { exact: true }).fill('이름을 바꾼 초안');
    await renameDialog.getByRole('button', { name: '적용', exact: true }).click();
    await expect(
      definitions.getByRole('heading', { name: '이름을 바꾼 초안', exact: true })
    ).toBeVisible();

    // Deletion keeps an explicit destructive action while retaining draft-only changes.
    const confirmation = page.getByRole('alertdialog', { name: '그룹 삭제', exact: true });
    await groupMenu.click();
    await definitions.getByRole('button', { name: '그룹 삭제', exact: true }).click();
    await actionPair(confirmation, '그룹 삭제', 'delete');
    await page.screenshot({ path: info.outputPath(`toggle-group-confirm-${viewport.name}.png`) });
    await confirmation.getByRole('button', { name: '취소', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(
      definitions.getByRole('heading', { name: '이름을 바꾼 초안', exact: true })
    ).toBeVisible();
    await groupMenu.click();
    await definitions.getByRole('button', { name: '그룹 삭제', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await expect(
      definitions.getByRole('heading', { name: '이름을 바꾼 초안', exact: true })
    ).toBeVisible();
    await groupMenu.click();
    await definitions.getByRole('button', { name: '그룹 삭제', exact: true }).click();
    await confirmation.getByRole('button', { name: '그룹 삭제', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await definitions.getByRole('button', { name: '소스', exact: true }).click();
    const raw = definitions.getByLabel('토글 정의 소스', { exact: true });
    expect(await raw.inputValue()).toContain('keep=보존할 입력=text');
    expect(await raw.inputValue()).not.toContain('초안');
    expect(await raw.inputValue()).not.toContain('취소할');
    const stored = (await (
      await request.get(`/api/prompt-presets/${preset.id}`)
    ).json()) as PromptPreset;
    expect(stored.program.nativeRisuPreset.preset.customPromptTemplateToggle).toBe(original);

    // Retain another approved group and prove only the parent Save persists the final draft.
    await definitions.getByRole('button', { name: '편집', exact: true }).click();
    await add.click();
    await addDialog.getByLabel('그룹 이름', { exact: true }).fill('저장할 그룹');
    await addDialog.getByRole('button', { name: '적용', exact: true }).click();
    const savedResponse = waitForResourceSave(page, 'prompt-preset', preset.id);
    await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
    const saved = (await savedResponse).saved as PromptPreset;
    expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).toContain(
      '=저장할 그룹=group'
    );
    expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).toContain(
      'keep=보존할 입력=text'
    );
    expect(saved.program.nativeRisuPreset.preset.customPromptTemplateToggle).not.toContain('초안');
  });

  test(`NATIVEACTIONS agent deletion is destructive and preserves other drafts on ${viewport.name}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const program = createDefaultRisuPrompt('Synthetic agent action fixture.');
    const keep = createAgentDefinition('character', 'keep-agent');
    const remove = createAgentDefinition('lore', 'remove-agent');
    program.collaboration = {
      ...createAgentCollaboration(),
      enabled: true,
      agents: [keep, remove],
    };
    const preset = await post<PromptPreset>(request, '/api/prompt-presets', {
      title: `Agent actions ${crypto.randomUUID()}`,
      role: 'main',
      program,
    });
    const editor = await openPrompt(page, preset);
    await editor.getByRole('tab', { name: '협업', exact: true }).click();
    const collaboration = editor.getByRole('region', { name: '에이전트 협업' });
    const shared = collaboration.getByLabel('함께 따를 지침', { exact: true });
    await shared.fill('삭제 확인 중에도 유지할 공유 지침');
    const survivor = collaboration.locator('.ac-agent').first();
    await survivor.locator('summary').click();
    await survivor
      .getByLabel('1번째 에이전트 지침', { exact: true })
      .fill('유지할 에이전트의 미저장 지침');
    const removed = collaboration.locator('.ac-agent').nth(1);
    await removed.locator('summary').click();
    const removeButton = removed.getByRole('button', { name: '2번째 에이전트 삭제', exact: true });
    const dialog = page.getByRole('alertdialog', { name: '에이전트 삭제', exact: true });
    await removeButton.click();
    await expect(dialog).toContainText('프롬프트를 저장하면 반영돼요.');
    await actionPair(dialog, '삭제', 'delete');
    await page.screenshot({ path: info.outputPath(`agent-delete-${viewport.name}.png`) });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(removeButton).toBeFocused();
    await expect(collaboration.locator('.ac-agent')).toHaveCount(2);
    await expect(shared).toHaveValue('삭제 확인 중에도 유지할 공유 지침');
    await expect(survivor.getByLabel('1번째 에이전트 지침', { exact: true })).toHaveValue(
      '유지할 에이전트의 미저장 지침'
    );
    await removeButton.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(collaboration.locator('.ac-agent')).toHaveCount(2);
    await removeButton.click();
    await dialog.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(collaboration.locator('.ac-agent')).toHaveCount(1);
    await expect(shared).toHaveValue('삭제 확인 중에도 유지할 공유 지침');
    const stored = (await (
      await request.get(`/api/prompt-presets/${preset.id}`)
    ).json()) as PromptPreset;
    expect(stored.program.collaboration).toEqual(preset.program.collaboration);
    const savedResponse = waitForResourceSave(page, 'prompt-preset', preset.id);
    await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
    const saved = (await savedResponse).saved as PromptPreset;
    expect(saved.program.collaboration).toMatchObject({
      sharedInstructions: '삭제 확인 중에도 유지할 공유 지침',
      agents: [{ id: keep.id, instructions: '유지할 에이전트의 미저장 지침' }],
    });
    expect(saved.program.collaboration!.agents).toHaveLength(1);
  });

  test(`NATIVEACTIONS asset removal preserves metadata drafts until parent save on ${viewport.name}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize(viewport);
    const image = await post<{ hash: string; mime: 'image/png' }>(
      request,
      '/api/package-image-blobs',
      {
        mime: 'image/png',
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
    if (viewport.name === 'mobile') {
      for (const width of [320, MOBILE_WIDTH]) {
        await page.setViewportSize({ width, height: MOBILE_HEIGHT });
        await expectVisibleSaveIcon(save);
      }
      await page.setViewportSize(viewport);
    }
    await selectPackageSection(page, '에셋');
    const library = page.getByTestId('library-panel');
    const images = library.getByLabel('Risu 이미지 목록', { exact: true });
    await images.getByRole('button', { name: '유지할 이미지', exact: true }).click();
    await library.getByLabel('이미지 설명', { exact: true }).fill('취소와 제거 후에도 유지할 설명');
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
    expect(
      await description.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await actionPair(dialog, '에셋 삭제', 'delete');
    await page.screenshot({ path: info.outputPath(`asset-remove-${viewport.name}.png`) });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(removeButton).toBeFocused();
    await expect(images.getByRole('button')).toHaveCount(2);
    await expect(library.getByLabel('이미지 이름', { exact: true })).toHaveValue(removedTitle);
    await removeButton.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(images.getByRole('button')).toHaveCount(2);
    await removeButton.click();
    await dialog.getByRole('button', { name: '에셋 삭제', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(images.getByRole('button')).toHaveCount(1);
    await expect(
      library.getByRole('status').filter({ hasText: '자료에서 제거했어요. 저장하면 적용돼요.' })
    ).toBeVisible();
    await images.getByRole('button', { name: '유지할 이미지', exact: true }).click();
    await expect(library.getByLabel('이미지 설명', { exact: true })).toHaveValue(
      '취소와 제거 후에도 유지할 설명'
    );
    const stored = (await (await request.get(`/api/content/${content.id}`)).json()) as Content;
    expect(stored.package!.images).toEqual(content.package!.images);
    let releaseSave: () => void = () => {};
    if (viewport.name === 'mobile') {
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route('**/api/resources/save', async (route) => {
        await saveGate;
        await route.continue();
      });
    }
    const savedResponse = waitForContentSave(page, content.id);
    try {
      await save.click();
      if (viewport.name === 'mobile') {
        await expect(save).toHaveAttribute('aria-busy', 'true');
        await expectVisibleSaveIcon(save);
      }
    } finally {
      releaseSave();
    }
    const saved = await savedResponse;
    expect(saved.package!.images).toMatchObject([
      { id: 'keep', description: '취소와 제거 후에도 유지할 설명' },
    ]);
    expect(saved.package!.images).toHaveLength(1);
    expect(saved.package!.images![0]!.blobHash).toBe(image.hash);
  });
}
