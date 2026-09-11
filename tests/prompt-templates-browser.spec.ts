import { expect, test } from '@playwright/test';
import type { EditDraft, DraftPatchResult } from '../core/edit-drafts.js';
import type { LibraryOrganization } from '../core/library-organization.js';
import type { PromptPreset } from '../core/product.js';
import { navigationAction } from './ui-navigation.js';

const titles = [
  'Phēmē',
  'Hermēneía',
  'Phēmē · 협업',
  'Phēmē · 시뮬레이션 협업',
  'Phēmē · OOC 검토',
];

test('BPTUI01 builtin templates create editable presets at 390/1440px and preserve existing work', async ({
  page,
  request,
}, info) => {
  const before = await (await request.get('/api/prompt-workspace')).json();
  const originalResponse = await request.post('/api/prompt-presets', {
    data: {
      title: `BPTUI01 existing ${crypto.randomUUID()}`,
      role: 'main',
      program: {
        version: 1,
        controls: [],
        blocks: [{ id: 'current', title: '현재 요청', kind: 'current' }],
      },
      values: {},
    },
  });
  expect(originalResponse.ok(), await originalResponse.text()).toBe(true);
  const original = (await originalResponse.json()) as PromptPreset;
  const draftResponse = await request.post('/api/edit-drafts', {
    data: {
      editorKey: `prompt-preset:${original.id}`,
      kind: 'prompt-preset',
      targetId: original.id,
      operationId: crypto.randomUUID(),
    },
  });
  expect(draftResponse.ok(), await draftResponse.text()).toBe(true);
  const draft = (await draftResponse.json()) as EditDraft;
  const patchedResponse = await request.patch(`/api/edit-drafts/${draft.id}`, {
    data: {
      expectedRevision: draft.revision,
      operationId: crypto.randomUUID(),
      model: { ...draft.model, title: 'Preserve this unsaved title' },
      rawFields: { program: '{ unfinished JSON' },
      unappliedFields: ['program'],
    },
  });
  expect(patchedResponse.ok(), await patchedResponse.text()).toBe(true);
  const preservedDraft = ((await patchedResponse.json()) as DraftPatchResult).draft;
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
    [390, 'pheme-collaboration', 'Phēmē · 협업', 'main'],
    [1440, 'hermeneia', 'Hermēneía', 'translation'],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.getByRole('button', { name: '기본 프롬프트', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '기본 프롬프트', exact: true });
    await expect(dialog.getByRole('listitem')).toHaveCount(5);
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
    await editor.getByRole('button', { name: '프리셋 저장', exact: true }).click();
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
  expect(await (await request.get(`/api/edit-drafts/${draft.id}`)).json()).toEqual(preservedDraft);
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
    await expect(dialog.getByRole('listitem')).toHaveCount(5);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.getByRole('button', { name: 'Phēmē 추가', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('프롬프트를 추가하지 못했어요');
    expect(writes).toBe(0);
    const acceptedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/prompt-presets' &&
        response.request().method() === 'POST'
    );
    // Dispatch both clicks before React can disable the button, exercising the synchronous lock.
    await dialog.getByRole('button', { name: 'Phēmē 다시 추가', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect.poll(() => writes).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Phēmē 추가', exact: true })).toBeDisabled();
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
    ).toHaveValue('Phēmē');
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
