import { nativePrompt } from './fixtures/native-prompt.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { expect, test } from '@playwright/test';
import type { LibraryOrganization } from '../core/library-organization.js';
import type { PromptPreset } from '../core/product.js';
import { navigationAction, selectEditorSection } from './ui-navigation.js';

const titles = ['Phēmē RP', 'Phēmē 소설', 'Hermēneía'];

test(`BPTUI01 builtin templates create editable presets at ${MOBILE_WIDTH}px and preserve existing work`, async ({
  page,
  request,
}) => {
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
  await panel
    .locator('.library-folder-chip-slot')
    .filter({ hasText: folder.title })
    .getByRole('button')
    .click();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 1000 });
  for (const [id, title, role] of [
    ['pheme-novel', 'Phēmē 소설', 'main'],
    ['hermeneia', 'Hermēneía', 'translation'],
  ] as const) {
    await panel.getByRole('button', { name: '템플릿', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '템플릿', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('listitem')).toHaveCount(3);
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(titles);
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
    await selectEditorSection(editor, '기본 옵션');
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
    const editedTitle = `${title} BPTUI01`;
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
