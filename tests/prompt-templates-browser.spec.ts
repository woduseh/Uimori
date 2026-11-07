import { nativePrompt } from './fixtures/native-prompt.js';
import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import type { LibraryOrganization } from '../core/library-organization.js';
import type { PromptPreset } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';

const titles = ['Phēmē RP', 'Phēmē 소설', 'Hermēneía'];

test(`BPTUI01 builtin templates create editable presets at ${MOBILE_WIDTH}/${DESKTOP_WIDTH}px and preserve existing work`, async ({
  page,
  request,
}, info) => {
  const before = await (await request.get('/api/prompt-workspace')).json();
  const originalResponse = await request.post('/api/prompt-presets', {
    data: {
      title: `BPTUI01 existing ${crypto.randomUUID()}`,
      role: 'main',
      program: nativePrompt('Synthetic current prompt.'),
      values: {},
    },
  });
  expect(originalResponse.ok(), await originalResponse.text()).toBe(true);
  const original = (await originalResponse.json()) as PromptPreset;
  const organization = (await (
    await request.get('/api/library/organization')
  ).json()) as LibraryOrganization;
  const folderTitle = `BPTUI01 ${crypto.randomUUID()}`;
  const folderResponse = await request.post('/api/library/folders', {
    data: { expectedRevision: organization.revision, category: 'prompts', title: folderTitle },
  });
  expect(folderResponse.ok(), await folderResponse.text()).toBe(true);
  const folder = ((await folderResponse.json()) as LibraryOrganization).folders.find(
    (item) => item.title === folderTitle
  )!;
  const errors: string[] = [];
  const workspaceWrites: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      new URL(request.url()).pathname.startsWith('/api/prompt-workspace')
    )
      workspaceWrites.push(request.url());
  });
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const panel = page.getByTestId('prompt-library');
  await panel.getByRole('button', { name: `${folder.title} 폴더 열기`, exact: true }).click();
  for (const [width, id, title, role] of [
    [MOBILE_WIDTH, 'pheme-novel', 'Phēmē 소설', 'main'],
    [DESKTOP_WIDTH, 'hermeneia', 'Hermēneía', 'translation'],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    if (width === MOBILE_WIDTH) {
      const actions = [
        panel.getByRole('button', { name: '프롬프트 가져오기', exact: true }),
        panel.getByRole('button', { name: '현재 프롬프트 설정', exact: true }),
        panel.getByRole('button', { name: '기본 프롬프트', exact: true }),
        panel.getByRole('button', { name: '새 프롬프트', exact: true }).first(),
      ];
      const search = panel.getByRole('searchbox', { name: '프롬프트 검색', exact: true });
      for (const control of [...actions, search]) await expect(control).toBeInViewport();
      const boxes = await Promise.all(actions.map((control) => control.boundingBox()));
      const searchBox = await search.boundingBox();
      expect(Math.max(...boxes.map((box) => box!.y))).toBeLessThan(
        Math.min(...boxes.map((box) => box!.y + box!.height))
      );
      expect(searchBox!.y).toBeGreaterThanOrEqual(
        Math.min(...boxes.map((box) => box!.y + box!.height))
      );
      expect(
        await panel
          .locator('.library-toolbar')
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
      ).toBe(true);
    }
    await panel.getByRole('button', { name: '기본 프롬프트', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '기본 프롬프트', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    const gap = width === MOBILE_WIDTH ? 16 : 24;
    expect(bounds.x).toBeGreaterThanOrEqual(gap);
    expect(bounds.y).toBeGreaterThanOrEqual(gap);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - gap);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000 - gap);
    expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y + bounds.height / 2 - 500)).toBeLessThanOrEqual(1);
    if (width === MOBILE_WIDTH) {
      await page.setViewportSize({ width, height: 320 });
      const header = dialog.locator(':scope > .dialog-header');
      const body = dialog.locator(':scope > .dialog-body');
      // The visualViewport resize handler may update dialog sizing after setViewportSize returns.
      await expect
        .poll(
          async () => {
            const bounds = await dialog.boundingBox();
            return (
              bounds !== null &&
              bounds.y >= 16 &&
              bounds.y + bounds.height <= 304 &&
              Math.abs(bounds.y + bounds.height / 2 - 160) <= 1
            );
          },
          { message: 'The dialog fits and centers in the resized 320px viewport' }
        )
        .toBe(true);
      const headerBefore = (await header.boundingBox())!;
      await body.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      expect((await header.boundingBox())!.y).toBe(headerBefore.y);
      const shortBounds = (await dialog.boundingBox())!;
      expect(shortBounds.y).toBeGreaterThanOrEqual(16);
      expect(shortBounds.y + shortBounds.height).toBeLessThanOrEqual(304);
      await expect(
        dialog.getByRole('button', { name: '기본 프롬프트 닫기', exact: true })
      ).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('prompt-templates-mobile-short.png') });
      await body.evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.setViewportSize({ width, height: 1000 });
    }
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(titles);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    for (const button of await dialog.getByRole('button', { name: / 추가$/ }).all()) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath(`prompt-templates-${width}.png`) });
    const template = await (await request.get(`/api/prompt-templates/${id}`)).json();
    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/prompt-presets' &&
        response.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: `${title} 추가`, exact: true }).click();
    const accepted = await createdResponse;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const created = (await accepted.json()) as PromptPreset;
    expect(created).toMatchObject({
      title,
      role,
      program: template.program,
      values: template.values,
    });
    await expect(dialog).toBeHidden();
    const editor = page.getByTestId('prompt-editor');
    await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
    await expect(editor.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(title);
    await expect(editor.getByLabel('프롬프트 역할', { exact: true })).toHaveValue(role);
    const placed = (await (
      await request.get('/api/library/organization')
    ).json()) as LibraryOrganization;
    expect(placed.items).toContainEqual({
      kind: 'prompt-preset',
      id: created.id,
      category: 'prompts',
      folderId: folder.id,
    });
    const editedTitle = `${title} BPTUI01 ${width}`;
    await editor.getByLabel('프롬프트 이름', { exact: true }).fill(editedTitle);
    await editor.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
    await expect
      .poll(
        async () => (await (await request.get(`/api/prompt-presets/${created.id}`)).json()).title
      )
      .toBe(editedTitle);
    const saved = await (await request.get(`/api/prompt-presets/${created.id}`)).json();
    expect(saved).toMatchObject({
      id: created.id,
      revision: created.revision + 1,
      title: editedTitle,
      role,
      program: template.program,
      values: template.values,
    });
    await panel.getByRole('button', { name: '프롬프트 목록', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: `${editedTitle} 프롬프트 편집`, exact: true })
    ).toBeVisible();
  }
  expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(before);
  expect(await (await request.get(`/api/prompt-presets/${original.id}`)).json()).toEqual(original);
  expect(workspaceWrites).toEqual([]);
  expect(errors).toEqual([]);
});

test('BPTUI02 template retry, dialog focus and duplicate clicks preserve a single accepted preset', async ({
  page,
  request,
}) => {
  const before = await (await request.get('/api/prompt-workspace')).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let listAttempts = 0;
  let detailAttempts = 0;
  let writes = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/prompt-templates', async (route) => {
    if (++listAttempts === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic template list failure' }),
      });
    else await route.continue();
  });
  await page.route('**/api/prompt-templates/pheme', async (route) => {
    if (++detailAttempts === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic template detail failure' }),
      });
    else await route.continue();
  });
  await page.route('**/api/prompt-presets', async (route) => {
    if (route.request().method() === 'POST') {
      writes++;
      await pending;
    }
    await route.continue();
  });
  try {
    await page.goto('/');
    await navigationAction(page, '프롬프트');
    const panel = page.getByTestId('prompt-library');
    const opener = panel.getByRole('button', { name: '기본 프롬프트', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '기본 프롬프트', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('기본 프롬프트를 불러오지 못했어요');
    await dialog.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.getByRole('button', { name: 'Phēmē RP 추가', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('프롬프트를 추가하지 못했어요');
    expect(writes).toBe(0);
    const acceptedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/prompt-presets' &&
        response.request().method() === 'POST'
    );
    // Dispatch both clicks before React can disable the button, exercising the synchronous lock.
    await dialog
      .getByRole('button', { name: 'Phēmē RP 다시 추가', exact: true })
      .evaluate((node) => {
        (node as HTMLButtonElement).click();
        (node as HTMLButtonElement).click();
      });
    await expect.poll(() => writes).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Phēmē RP 추가', exact: true })).toBeDisabled();
    await page.route('**/api/library?view=summary', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'synthetic summary failure after save' }),
      })
    );
    release();
    const accepted = await acceptedResponse;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const saved = (await accepted.json()) as PromptPreset;
    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId('prompt-editor').getByLabel('프롬프트 이름', { exact: true })
    ).toHaveValue('Phēmē RP');
    expect(writes).toBe(1);
    expect(detailAttempts).toBe(2);
    expect(await (await request.get(`/api/prompt-presets/${saved.id}`)).json()).toEqual(saved);
    expect(await (await request.get('/api/prompt-workspace')).json()).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const action of ['save', 'clone', 'add'] as const) {
  test(`BPTUI03 ${action} keeps the created prompt when folder placement fails`, async ({
    page,
    request,
  }) => {
    const title = `BPTUI03 ${action} ${crypto.randomUUID()}`;
    const seedResponse = await request.post('/api/prompt-presets', {
      data: {
        title,
        role: 'main',
        program: nativePrompt('Synthetic placement failure.'),
        values: {},
      },
    });
    expect(seedResponse.ok(), await seedResponse.text()).toBe(true);
    const seed = (await seedResponse.json()) as PromptPreset;
    const initial = (await (
      await request.get('/api/library/organization')
    ).json()) as LibraryOrganization;
    const folderTitle = `BPTUI03 folder ${crypto.randomUUID()}`;
    const folderResponse = await request.post('/api/library/folders', {
      data: { expectedRevision: initial.revision, category: 'prompts', title: folderTitle },
    });
    expect(folderResponse.ok(), await folderResponse.text()).toBe(true);
    const organization = (await folderResponse.json()) as LibraryOrganization;
    const folder = organization.folders.find((item) => item.title === folderTitle)!;
    if (action === 'clone') {
      const move = await request.post('/api/library/organization/move', {
        data: {
          expectedRevision: organization.revision,
          category: 'prompts',
          folderId: folder.id,
          items: [{ kind: 'prompt-preset', id: seed.id }],
        },
      });
      expect(move.ok(), await move.text()).toBe(true);
    }
    await page.goto('/');
    await navigationAction(page, '프롬프트');
    const panel = page.getByTestId('prompt-library');
    await panel.getByRole('button', { name: `${folderTitle} 폴더 열기`, exact: true }).click();
    if (action === 'save') {
      await panel.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
      const editor = page.getByTestId('prompt-editor');
      await editor.getByRole('tab', { name: '기본 옵션', exact: true }).click();
      await editor.getByLabel('프롬프트 이름', { exact: true }).fill(`${title} saved`);
    } else if (action === 'add') {
      await panel.getByRole('button', { name: '기본 프롬프트', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '기본 프롬프트', exact: true })).toBeVisible();
    }
    await page.route('**/api/library/organization/move', (route) =>
      route.fulfill({ status: 503, json: { error: 'synthetic placement failure' } })
    );
    const accepted = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return (
        response.request().method() === 'POST' &&
        path ===
          (action === 'save'
            ? '/api/resources/save'
            : action === 'clone'
              ? '/api/resources/clone'
              : '/api/prompt-presets')
      );
    });
    if (action === 'save') {
      await page
        .getByTestId('prompt-editor')
        .getByRole('button', { name: '프롬프트 저장', exact: true })
        .click();
    } else if (action === 'clone') {
      const row = panel.locator(`[data-library-item-id="${seed.id}"]`);
      await row.getByLabel(`${title} 메뉴`, { exact: true }).click();
      await row.getByRole('button', { name: '복제', exact: true }).click();
    } else {
      await page
        .getByRole('dialog', { name: '기본 프롬프트', exact: true })
        .getByRole('button', { name: 'Phēmē RP 추가', exact: true })
        .click();
    }
    const response = await accepted;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = await response.json();
    const saved = (action === 'add' ? payload : payload.saved) as PromptPreset;
    expect(saved.id).toBeTruthy();
    expect(saved.id).not.toBe(seed.id);
    const warning = page.locator('.destination-scroll > .dismissible-error p');
    const verb = action === 'save' ? '저장' : action === 'clone' ? '복제' : '추가';
    await expect(warning).toHaveText(`프롬프트는 ${verb}됐지만 폴더에 배치하지 못했어요.`);
    const persisted = await request.get(`/api/prompt-presets/${saved.id}`);
    expect(persisted.ok(), await persisted.text()).toBe(true);
    expect(await persisted.json()).toMatchObject({ id: saved.id, title: saved.title });
    const after = (await (
      await request.get('/api/library/organization')
    ).json()) as LibraryOrganization;
    expect(
      after.items.some(
        (item) =>
          item.kind === 'prompt-preset' && item.id === saved.id && item.folderId === folder.id
      )
    ).toBe(false);
  });
}

test('BPTUI04 template placement keeps an independent organization lookup error', async ({
  page,
  request,
}) => {
  const initial = (await (
    await request.get('/api/library/organization')
  ).json()) as LibraryOrganization;
  const folderTitle = `BPTUI04 folder ${crypto.randomUUID()}`;
  const folderResponse = await request.post('/api/library/folders', {
    data: { expectedRevision: initial.revision, category: 'prompts', title: folderTitle },
  });
  expect(folderResponse.ok(), await folderResponse.text()).toBe(true);
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const panel = page.getByTestId('prompt-library');
  await panel.getByRole('button', { name: `${folderTitle} 폴더 열기`, exact: true }).click();
  await panel.getByRole('button', { name: '기본 프롬프트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '기본 프롬프트', exact: true });
  await expect(dialog.getByRole('button', { name: 'Phēmē RP 추가', exact: true })).toBeVisible();
  await page.route('**/api/library/organization', (route) =>
    route.fulfill({ status: 503, json: { error: 'synthetic organization lookup failure' } })
  );
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/prompt-presets' &&
      response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: 'Phēmē RP 추가', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  const saved = (await response.json()) as PromptPreset;
  const warning = page.locator('.destination-scroll > .dismissible-error p');
  await expect(warning).toHaveText(
    '프롬프트는 추가됐지만 폴더에 배치하지 못했어요. 서버 작업을 완료하지 못했어요. (503)'
  );
  const persisted = await request.get(`/api/prompt-presets/${saved.id}`);
  expect(persisted.ok(), await persisted.text()).toBe(true);
  expect(await persisted.json()).toMatchObject({ id: saved.id, title: 'Phēmē RP' });
});
