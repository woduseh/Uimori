import { test, expect } from '@playwright/test';
import type { Library, PromptPreset } from '../core/product.js';
import type { LibraryOrganization } from '../core/library-organization.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { navigationAction } from './ui-navigation.js';

for (const width of DEFAULT_WIDTHS) {
  test(`PORDER01 ${width} prompt order survives reload and folder movement preserves content`, async ({
    page,
    request,
  }) => {
    const prefix = `PORDER01 ${width} ${crypto.randomUUID()}`;
    const presets: PromptPreset[] = [];
    for (const suffix of ['Alpha', 'Beta', 'Gamma']) {
      const response = await request.post('/api/prompt-presets', {
        data: {
          title: `${prefix} ${suffix}`,
          role: 'main',
          program: createDefaultRisuPrompt(`Synthetic ${suffix}`, 'main'),
          values: {},
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      presets.push(await response.json());
    }
    const readOrganization = async () => {
      const response = await request.get('/api/library/organization');
      expect(response.ok()).toBe(true);
      return response.json() as Promise<LibraryOrganization>;
    };
    const folderIds: string[] = [];
    for (const title of [`${prefix} Folder A`, `${prefix} Folder B`]) {
      const current = await readOrganization();
      const response = await request.post('/api/library/folders', {
        data: {
          expectedRevision: current.revision,
          category: 'prompts',
          title,
        },
      });
      expect(response.ok()).toBe(true);
      const state = (await response.json()) as LibraryOrganization;
      folderIds.push(state.folders.find((folder) => folder.title === title)!.id);
    }
    const ids = presets.map((preset) => preset.id);
    // Keep the real organization mutations while removing unrelated shared-runner list entries.
    await page.route(/\/api\/library(?:\?|$)/, async (route) => {
      const upstream = await route.fetch();
      const library = (await upstream.json()) as Library;
      await route.fulfill({
        response: upstream,
        json: {
          ...library,
          promptPresets: library.promptPresets?.filter((preset) => ids.includes(preset.id)),
          organization: {
            ...library.organization,
            folders: library.organization!.folders.filter((folder) =>
              folderIds.includes(folder.id)
            ),
            items: library.organization!.items.filter((item) => ids.includes(item.id)),
          },
        },
      });
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await navigationAction(page, '프롬프트');
    const panel = page.getByTestId('prompt-library');
    const options = panel.getByLabel('목록 관리', { exact: true });
    await options.click();
    await panel.getByLabel('프롬프트 정렬', { exact: true }).selectOption('manual');
    await page.keyboard.press('Escape');
    const item = (id: string) => panel.locator(`[data-library-item-id="${id}"]`);
    const displayedIds = () =>
      panel
        .locator('[data-library-item-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-library-item-id')));
    if (width > 600) {
      await item(ids[1]).dragTo(item(ids[0]));
    } else {
      await item(ids[1]).getByLabel(`${presets[1].title} 메뉴`, { exact: true }).click();
      await item(ids[1]).getByRole('button', { name: '위로 이동', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await expect.poll(displayedIds).toEqual([ids[1], ids[0], ids[2]]);
    await page.reload();
    await navigationAction(page, '프롬프트');
    await expect.poll(displayedIds).toEqual([ids[1], ids[0], ids[2]]);
    await options.click();
    await expect(panel.getByLabel('프롬프트 정렬', { exact: true })).toHaveValue('manual');
    await page.keyboard.press('Escape');
    if (width > 600) {
      await panel
        .locator(`[data-folder-id="${folderIds[1]}"]`)
        .dragTo(panel.locator(`[data-folder-id="${folderIds[0]}"]`), {
          targetPosition: { x: 4, y: 4 },
        });
      await expect
        .poll(async () =>
          (await readOrganization()).folders
            .filter((folder) => folderIds.includes(folder.id))
            .sort((a, b) => a.sortPosition - b.sortPosition)
            .map((folder) => folder.id)
        )
        .toEqual([folderIds[1], folderIds[0]]);
      await item(ids[1]).dragTo(panel.locator(`[data-folder-id="${folderIds[0]}"]`));
    } else {
      await item(ids[1]).getByLabel(`${presets[1].title} 메뉴`, { exact: true }).click();
      await item(ids[1]).getByRole('button', { name: '폴더 이동', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '자료 이동', exact: true });
      await dialog.getByLabel('이동할 폴더', { exact: true }).selectOption(folderIds[0]);
      await dialog.getByRole('button', { name: '이동', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await expect
      .poll(
        async () => (await readOrganization()).items.find((entry) => entry.id === ids[1])?.folderId
      )
      .toBe(folderIds[0]);
    await panel.getByRole('button', { name: `${prefix} Folder A 폴더 열기`, exact: true }).click();
    await expect.poll(displayedIds).toEqual([ids[1]]);
    const stored = await request.get(`/api/prompt-presets/${ids[1]}`);
    expect(stored.ok()).toBe(true);
    expect(await stored.json()).toEqual(presets[1]);
    await page.screenshot({ path: test.info().outputPath(`prompt-manual-order-${width}.png`) });
    await page.reload();
    await navigationAction(page, '프롬프트');
    await panel.getByRole('button', { name: `${prefix} Folder A 폴더 열기`, exact: true }).click();
    await expect.poll(displayedIds).toEqual([ids[1]]);
  });
}
