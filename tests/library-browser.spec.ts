import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Locator,
} from './fixtures/browser-test.js';
import type { Content, Library, PromptPreset } from '../core/product.js';
import { type LibraryOrganization, type LibraryFolder } from '../core/library-organization.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import {
  createLibraryContent,
  editorChanges,
  navigationAction,
  selectEditorSection,
} from './ui-navigation.js';

async function createContent(request: APIRequestContext, title: string) {
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: '함께 이야기할 합성 캐릭터와 세계',
      text: 'Synthetic common body',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Content>;
}
async function organization(request: APIRequestContext) {
  const response = await request.get('/api/library/organization');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<LibraryOrganization>;
}
async function createFolder(page: Page, panel: Locator, title: string) {
  await expect(panel.locator('.library-folder-bar')).toBeVisible();
  await panel.getByRole('button', { name: '새 폴더', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '새 폴더', exact: true });
  await dialog.getByLabel('폴더 이름', { exact: true }).fill(title);
  const create = dialog.getByRole('button', { name: '폴더 만들기', exact: true });
  await expect(create).toHaveClass(/primary/);
  expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await create.click();
  await expect(dialog).toBeHidden();
  return (await organization(page.request)).folders.find((folder) => folder.title === title)!;
}
async function revealListOptions(panel: Locator) {
  const summary = panel.locator('.library-list-options > summary');
  if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await summary.click();
}
function folderChip(panel: Locator, title: string) {
  return title === '전체'
    ? panel.locator('.library-folder-bar').getByRole('button', { name: /^전체 \d+$/ })
    : panel.locator('.library-folder-chip-slot').filter({ hasText: title }).getByRole('button');
}
async function chooseFolder(panel: Locator, title: string) {
  const chip = folderChip(panel, title);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}
async function moveItems(
  page: Page,
  panel: Locator,
  titles: string[],
  category: string,
  folder: LibraryFolder | null
) {
  await panel.getByRole('button', { name: '목록', exact: true }).click();
  await revealListOptions(panel);
  await panel.getByRole('button', { name: '선택', exact: true }).click();
  for (const title of titles)
    await panel.getByRole('checkbox', { name: `${title} 선택`, exact: true }).check();
  await panel.getByRole('button', { name: '선택한 자료 이동', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자료 이동', exact: true });
  await dialog.getByLabel('이동할 분류', { exact: true }).selectOption(category);
  await dialog.getByLabel('이동할 폴더', { exact: true }).selectOption(folder?.id ?? '');
  await dialog.getByRole('button', { name: '이동', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('LIBUI01 library folders move and classify without changing revisions or owned chats', async ({
  page,
  request,
}, info) => {
  const prefix = `LIBUI01 ${Date.now()}`;
  const a = await createContent(request, `${prefix} Alpha`),
    b = await createContent(request, `${prefix} Beta`);
  const chat = await (
    await request.post('/api/chats', { data: { title: `${prefix} saved chat`, botId: a.id } })
  ).json();
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await expect(panel.getByRole('tab')).toHaveText(['봇', '페르소나', '모듈']);
  const folder = await createFolder(page, panel, `${prefix} Adventure`);
  const otherFolder = await createFolder(page, panel, `${prefix} Draft`);
  await chooseFolder(panel, '전체');
  await panel
    .locator(`[data-folder-id="${otherFolder.id}"]`)
    .dragTo(panel.locator(`[data-folder-id="${folder.id}"]`), { targetPosition: { x: 4, y: 4 } });
  await expect
    .poll(async () => {
      const order = (await organization(request)).folders
        .filter((item) => item.category === 'bot')
        .sort((a, b) => a.sortPosition - b.sortPosition)
        .map((item) => item.id);
      return order.indexOf(otherFolder.id) < order.indexOf(folder.id);
    })
    .toBe(true);
  const ordered = (await organization(request)).folders
    .filter((item) => item.category === 'bot')
    .sort((a, b) => a.sortPosition - b.sortPosition);
  expect(ordered.findIndex((item) => item.id === otherFolder.id)).toBeLessThan(
    ordered.findIndex((item) => item.id === folder.id)
  );
  await panel.getByRole('button', { name: '목록', exact: true }).click();
  const targetFolder = panel.locator(`[data-folder-id="${folder.id}"]`);
  const targetBox = (await targetFolder.boundingBox())!;
  await panel.locator(`[data-folder-id="${otherFolder.id}"]`).dragTo(targetFolder, {
    targetPosition: { x: targetBox.width - 4, y: 4 },
  });
  await expect
    .poll(async () => {
      const order = (await organization(request)).folders
        .filter((item) => item.category === 'bot')
        .sort((a, b) => a.sortPosition - b.sortPosition)
        .map((item) => item.id);
      return order.indexOf(folder.id) < order.indexOf(otherFolder.id);
    })
    .toBe(true);
  await page.reload();
  await expect
    .poll(() =>
      panel
        .locator('.library-folder-chip-slot')
        .evaluateAll(
          (nodes, expected) =>
            nodes
              .map((node) => node.getAttribute('data-folder-id'))
              .filter((id) => expected.includes(id ?? '')),
          [folder.id, otherFolder.id]
        )
    )
    .toEqual([folder.id, otherFolder.id]);
  await panel.getByLabel(`${otherFolder.title} 폴더 메뉴`, { exact: true }).click();
  await expect(panel.getByRole('button', { name: '위로', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '아래로', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await chooseFolder(panel, '전체');
  await panel.getByLabel('서재 검색', { exact: true }).fill(prefix);
  await moveItems(page, panel, [a.title, b.title], 'bot', folder);
  await chooseFolder(panel, folder.title);
  await expect(panel.locator('.library-open-content')).toHaveCount(2);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-bot-cards-desktop.png') });
  await panel.getByRole('tab', { name: '페르소나', exact: true }).click();
  const personas = await createFolder(page, panel, `${prefix} People`);
  await panel.getByRole('tab', { name: '봇', exact: true }).click();
  await chooseFolder(panel, folder.title);
  await moveItems(page, panel, [a.title], 'persona', personas);
  const revision = await (await request.get(`/api/revisions/content/${a.id}/${a.revision}`)).json();
  expect(revision).toEqual(a);
  const currentChat = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(currentChat.chat.botId).toBe(a.id);
  await panel.getByRole('tab', { name: '페르소나', exact: true }).click();
  await chooseFolder(panel, personas.title);
  await expect(panel.getByRole('button', { name: `${a.title} 편집`, exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '카드', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await panel.getByRole('button', { name: '목록', exact: true }).click();
  await expect(panel.locator('.library-list-item')).toHaveCount(1);
  await panel.getByRole('button', { name: '카드', exact: true }).click();
  await page.reload();
  await page
    .getByTestId('library-panel')
    .getByRole('tab', { name: '페르소나', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: '카드', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await chooseFolder(panel, personas.title);
  await expect(panel.getByRole('button', { name: `${a.title} 편집`, exact: true })).toBeVisible();
});

test('LIBUI03 prompts have independent folders and unsaved edits survive a cancelled navigation', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const prefix = `LIBUI03 ${Date.now()}`;
  const prompt = await (
    await request.post('/api/prompt-presets', {
      data: {
        title: prefix,
        role: 'main',
        program: createDefaultRisuPrompt('Synthetic instructions', 'main'),
      },
    })
  ).json();
  await page.goto('/');
  await navigationAction(page, '프롬프트');
  const panel = page.getByTestId('prompt-library');
  await expect(page.getByTestId('library-panel')).toHaveCount(0);
  const folder = await createFolder(page, panel, `${prefix} Presets`);
  await chooseFolder(panel, '전체');
  await panel.getByLabel('프롬프트 검색', { exact: true }).fill(prefix);
  await panel.getByLabel(`${prefix} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: '폴더 이동', exact: true }).click();
  const move = page.getByRole('dialog', { name: '자료 이동', exact: true });
  await expect(move.getByLabel('이동할 분류')).toBeDisabled();
  await move.getByLabel('이동할 폴더').selectOption(folder.id);
  await move.getByRole('button', { name: '이동', exact: true }).click();
  await expect(move).toBeHidden();
  await panel.getByLabel('프롬프트 검색', { exact: true }).fill('');
  await chooseFolder(panel, folder.title);
  await panel.getByRole('button', { name: `${prefix} 프롬프트 편집`, exact: true }).click();
  await selectEditorSection(panel, '기본 옵션');
  await panel.getByLabel('프롬프트 이름', { exact: true }).fill(`${prefix} Unsaved`);
  await navigationAction(page, '서재');
  const guard = page.getByRole('dialog', { name: '편집 중인 자료', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '탐색', exact: true })).toBeHidden();
  await expect(panel.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(`${prefix} Unsaved`);
  await panel.getByRole('button', { name: '프롬프트 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await (await request.get('/api/library')).json()) as Library).promptPresets?.find(
          (item) => item.id === prompt.id
        )?.revision
    )
    .toBe(2);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-management-mobile.png') });
  expect((await organization(request)).items.find((item) => item.id === prompt.id)?.folderId).toBe(
    folder.id
  );
  await selectEditorSection(panel, '기본 옵션');
  await panel.getByLabel('프롬프트 이름', { exact: true }).fill(`${prefix} Discard this draft`);
  await navigationAction(page, '서재');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '초안 버리고 이동', exact: true }).click();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  expect((await (await request.get(`/api/prompt-presets/${prompt.id}`)).json()).title).toBe(
    `${prefix} Unsaved`
  );
  await navigationAction(page, '프롬프트');
  await panel.getByRole('button', { name: `${prefix} Unsaved 프롬프트 편집`, exact: true }).click();
  await expect(panel.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(`${prefix} Unsaved`);
});

{
  const destination = 'new-draft';
  test(`PROMPTOPEN late preset read preserves ${destination} navigation`, async ({
    page,
    request,
  }) => {
    const title = `PROMPTOPEN ${destination} ${Date.now()}`;
    const response = await request.post('/api/prompt-presets', {
      data: {
        title,
        role: 'main',
        program: createDefaultRisuPrompt('Synthetic delayed preset', 'main'),
      },
    });
    expect(response.ok()).toBe(true);
    const preset = (await response.json()) as PromptPreset;
    await page.goto('/');
    await navigationAction(page, '프롬프트');
    const panel = page.getByTestId('prompt-library');
    await panel.getByLabel('프롬프트 검색', { exact: true }).fill(title);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const reading = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const path = `**/api/prompt-presets/${preset.id}`;
    await page.route(path, async (route) => {
      const saved = await route.fetch();
      requested();
      await held;
      await route.fulfill({ response: saved });
    });
    try {
      await panel.getByRole('button', { name: `${title} 프롬프트 편집`, exact: true }).click();
      await reading;
      await panel.getByRole('button', { name: '새 프롬프트', exact: true }).first().click();
      await selectEditorSection(panel, '기본 옵션');
      await panel.getByLabel('프롬프트 이름', { exact: true }).fill(`${title} 새 초안`);
      release();
      await page.waitForLoadState('networkidle');
      await expect(panel.getByLabel('프롬프트 이름', { exact: true })).toHaveValue(
        `${title} 새 초안`
      );
      await expect(page.getByRole('alertdialog', { name: '미저장 프롬프트 확인' })).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('LIBCLONE03 accepted content clone opens its saved copy when placement and refresh fail without repeating the write', async ({
  page,
  request,
}) => {
  const title = `LIBCLONE03 ${Date.now()}`;
  const source = await createContent(request, title);
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  const folder = await createFolder(page, panel, `${title} folder`);
  const placed = await request.post('/api/library/organization/move', {
    data: {
      expectedRevision: (await organization(request)).revision,
      items: [{ kind: 'content', id: source.id }],
      category: 'bot',
      folderId: folder.id,
    },
  });
  expect(placed.ok(), await placed.text()).toBe(true);
  await page.reload();
  await chooseFolder(panel, folder.title);
  let clones = 0;
  let placements = 0;
  await page.route('**/api/resources/clone', async (route) => {
    clones++;
    await route.continue();
  });
  await page.route('**/api/library/organization/move', async (route) => {
    placements++;
    await route.fulfill({ status: 503, json: { error: 'Synthetic clone placement failure' } });
  });
  await page.route('**/api/library?view=summary', (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic clone refresh failure' } })
  );
  await panel.getByLabel(`${title} 메뉴`, { exact: true }).click();
  const cloned = page.waitForResponse('**/api/resources/clone');
  await panel.getByRole('button', { name: '복제', exact: true }).click();
  const response = await cloned;
  expect(response.ok(), await response.text()).toBe(true);
  const copy = (await response.json()).saved as Content;
  const editor = page.getByRole('region', { name: '자료 상세', exact: true });
  await expect(editor.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toHaveValue(`${title} 사본`);
  const warning = page.getByRole('alert').filter({ hasText: '자료는 복제됐지만' });
  await expect(warning).toContainText('폴더에 배치하지 못했어요.');
  await expect(warning).toContainText('목록을 다시 불러오지 못했어요.');
  const library = (await (await request.get('/api/library')).json()) as Library;
  expect(library.contents.filter((item) => item.title === `${title} 사본`)).toHaveLength(1);
  expect(
    (await organization(request)).items.find((item) => item.id === copy.id)?.folderId
  ).toBeNull();
  expect(await (await request.get(`/api/content/${source.id}`)).json()).toEqual(source);
  expect(await (await request.get(`/api/content/${copy.id}`)).json()).toEqual(copy);
  expect(clones).toBe(1);
  expect(placements).toBe(1);
});

{
  const width = MOBILE_WIDTH;
  test(`LIBUI06 deleting a folder keeps its resources unclassified at ${width}px`, async ({
    page,
    request,
  }) => {
    const prefix = `LIBUI06 ${width} ${Date.now()}`;
    const loose = await createContent(request, `${prefix} Loose`);
    const filed = await createContent(request, `${prefix} Filed`);
    const before = await organization(request);
    const created = await request.post('/api/library/folders', {
      data: { expectedRevision: before.revision, category: 'bot', title: `${prefix} Folder` },
    });
    expect(created.ok()).toBe(true);
    const folders = (await created.json()) as LibraryOrganization;
    const folder = folders.folders.find((entry) => entry.title === `${prefix} Folder`)!;
    const moved = await request.post('/api/library/organization/move', {
      data: {
        expectedRevision: folders.revision,
        items: [{ kind: 'content', id: filed.id }],
        category: 'bot',
        folderId: folder.id,
      },
    });
    expect(moved.ok()).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const panel = page.getByTestId('library-panel');
    await panel.getByRole('button', { name: '목록', exact: true }).click();
    await expect(
      panel
        .locator(`[data-folder-section="${folder.id}"]`)
        .getByRole('button', { name: `${filed.title} 편집`, exact: true })
    ).toBeVisible();
    await expect(
      panel
        .locator('[data-folder-section=""]')
        .getByRole('button', { name: `${loose.title} 편집`, exact: true })
    ).toBeVisible();
    await panel.getByLabel(`${folder.title} 폴더 메뉴`, { exact: true }).click();
    await panel.getByRole('button', { name: `${folder.title} 폴더 삭제`, exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await confirm.getByRole('button', { name: '폴더 삭제', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(
      panel.getByRole('button', { name: `${filed.title} 편집`, exact: true })
    ).toBeVisible();
    expect(
      (await organization(request)).items.find((entry) => entry.id === filed.id)?.folderId
    ).toBeNull();
  });
}

test('LIBUI08 manual order persists and a bot card can be dropped into a folder', async ({
  page,
  request,
}, info) => {
  const prefix = `LIBUI08 ${Date.now()}`;
  const alpha = await createContent(request, `${prefix} Alpha`);
  const beta = await createContent(request, `${prefix} Beta`);
  let state = await organization(request);
  const response = await request.post('/api/library/folders', {
    data: {
      expectedRevision: state.revision,
      category: 'bot',
      title: `${prefix} Folder`,
    },
  });
  expect(response.ok()).toBe(true);
  state = await response.json();
  const folder = state.folders.find((entry) => entry.title === `${prefix} Folder`)!;
  await page.route(/\/api\/library(?:\?|$)/, async (route) => {
    const upstream = await route.fetch().catch(() => undefined);
    const current = (await upstream?.json().catch(() => undefined)) as Library | undefined;
    if (!upstream || !current) return;
    if (!current.organization) throw new Error('Library organization missing');
    await route.fulfill({
      response: upstream,
      json: {
        ...current,
        contents: current.contents.filter((item) => [alpha.id, beta.id].includes(item.id)),
        organization: {
          ...current.organization,
          folders: current.organization.folders.filter((entry) => entry.id === folder.id),
          items: current.organization.items.filter((entry) =>
            [alpha.id, beta.id].includes(entry.id)
          ),
        },
      },
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  let panel = page.getByTestId('library-panel');
  await panel.getByLabel('자료 정렬', { exact: true }).selectOption('manual');

  const item = (id: string) => panel.locator(`[data-library-item-id="${id}"]`);
  await item(beta.id).dragTo(item(alpha.id));
  await expect
    .poll(async () => {
      const order = await panel
        .locator('[data-library-item-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-library-item-id')));
      return order.indexOf(beta.id) < order.indexOf(alpha.id);
    })
    .toBe(true);

  await page.reload();
  panel = page.getByTestId('library-panel');
  await expect(panel.getByLabel('자료 정렬', { exact: true })).toHaveValue('manual');
  const afterReload = await panel
    .locator('[data-library-item-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-library-item-id')));
  expect(afterReload.indexOf(beta.id)).toBeLessThan(afterReload.indexOf(alpha.id));
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-manual-order-desktop.png') });

  await panel
    .locator(`[data-library-item-id="${beta.id}"]`)
    .dragTo(panel.locator(`[data-folder-id="${folder.id}"]`));
  await expect
    .poll(
      async () =>
        (await organization(request)).items.find((entry) => entry.id === beta.id)?.folderId
    )
    .toBe(folder.id);
  const section = panel.locator(`[data-folder-section="${folder.id}"]`);
  await expect(section.locator(`[data-library-item-id="${beta.id}"]`)).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-folder-drop-desktop.png') });
  await panel.getByLabel('자료 정렬', { exact: true }).selectOption('name');
  await panel.getByRole('button', { name: '목록', exact: true }).click();
  const folderOf = async (id: string) =>
    (await organization(request)).items.find((entry) => entry.id === id)?.folderId;
  await item(beta.id).dragTo(panel.locator('[data-folder-section=""] .library-section-heading'));
  await expect.poll(() => folderOf(beta.id)).toBeNull();
  for (const id of [alpha.id, beta.id]) {
    await item(id).dragTo(section.locator('.library-section-heading'));
    await expect.poll(() => folderOf(id)).toBe(folder.id);
  }
  await expect(section.locator('[data-library-item-id]')).toHaveCount(2);
  await expect(panel.locator('[data-folder-section=""]')).toHaveCount(0);
  await expect(panel.locator('.library-empty')).toHaveCount(0);
  await page.reload();
  await expect(section.locator('[data-library-item-id]')).toHaveCount(2);
  await expect(panel.locator('.library-empty')).toHaveCount(0);
});

test('EDITORRECOVERY2 confirms an uncertain new resource despite an incomplete later title', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 800 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const panel = page.getByTestId('library-panel');
  await createLibraryContent(page);
  const name = panel.getByLabel(/^(봇|페르소나|모듈) 이름$/u);
  const title = `EDITORRECOVERY2 ${crypto.randomUUID()}`;
  await name.fill(title);
  const submissions: Record<string, unknown>[] = [];
  let createdId = '';
  await page.route('**/api/resources/save', async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.ok(), await accepted.text()).toBe(true);
      createdId = (await accepted.json()).saved.id;
      await route.abort('failed');
    } else await route.continue();
  });
  await panel.getByRole('button', { name: '자료 등록', exact: true }).click();
  const retry = panel.getByRole('button', { name: '이전 요청 확인', exact: true });
  await expect(retry).toBeEnabled();
  await name.fill('');
  await retry.click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toEqual(submissions[0]);
  await expect(name).toHaveValue('');
  await expect(editorChanges(panel)).toBeVisible();
  const saved = await request.get(`/api/content/${createdId}`);
  expect(saved.ok(), await saved.text()).toBe(true);
  expect((await saved.json()).title).toBe(title);
});
