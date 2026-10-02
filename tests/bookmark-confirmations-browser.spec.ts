import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Bookmark } from '../core/reading-state.js';
import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { createReadingChat } from './fixtures/personal-workspace.js';

test.setTimeout(60000);

async function openBookmarks(page: Page, chatId: string) {
  await page.goto(`/?chat=${chatId}`);
  await expect(page.locator('[data-testid="source"]').first()).toBeVisible();
  await page
    .getByRole('button', { name: '장면 목록 열기', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const navigator = page.getByRole('dialog', { name: '장면 목록', exact: true });
  await navigator
    .locator('summary')
    .filter({ hasText: /^책갈피$/ })
    .click();
  const list = navigator.getByRole('region', { name: '이 채팅의 책갈피', exact: true });
  await expect(list.getByRole('status')).toHaveCount(0);
  return { navigator, list };
}

async function seedBookmark(request: APIRequestContext, width: number) {
  const { chat } = await createReadingChat(request, `책갈피 확인 ${width} ${Date.now()}`, 1);
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  const response = await request.post(`/api/chats/${chat.id}/bookmarks`, {
    data: {
      id: crypto.randomUUID(),
      title: '검토할 책갈피',
      note: '저장된 메모',
      quote: 'Scene 1.',
      target: { chatId: chat.id, sourceId: detail.sources[0].id, representation: 'original' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return { chat, bookmark: (await response.json()) as Bookmark };
}

async function savedBookmarks(request: APIRequestContext, chatId: string) {
  return (await (await request.get(`/api/chats/${chatId}/bookmarks`)).json()) as Bookmark[];
}

async function centered(dialog: Locator, width: number) {
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const gap = width === MOBILE_WIDTH ? 16 : 24;
  expect(box.x).toBeGreaterThanOrEqual(gap);
  expect(box.y).toBeGreaterThanOrEqual(gap);
  expect(box.x + box.width).toBeLessThanOrEqual(width - gap);
  expect(box.y + box.height).toBeLessThanOrEqual(900 - gap);
  expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - 450)).toBeLessThanOrEqual(1);
  expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
    1
  );
}

function nativeDialogs(page: Page) {
  const messages: string[] = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.dismiss();
  });
  return messages;
}

for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
  test(`BMCONF01 bookmark discard cancellation, Escape, backdrop and save preserve data and focus at ${width}`, async ({
    page,
    request,
  }, info) => {
    const { chat, bookmark } = await seedBookmark(request, width);
    const native = nativeDialogs(page);
    await page.setViewportSize({ width, height: 900 });
    const { navigator, list } = await openBookmarks(page, chat.id);
    const opener = list.getByRole('button', { name: `${bookmark.title} 책갈피 편집`, exact: true });
    const editor = page.locator('dialog.bookmark-dialog');
    const close = editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true });
    const confirmation = page.getByRole('alertdialog', { name: '미저장 책갈피 확인', exact: true });
    await opener.click();
    await editor.getByLabel('책갈피 이름').fill('저장하지 않은 이름');
    await editor.getByLabel('책갈피 메모').fill('취소해도 남아야 하는 메모');
    await close.click();
    await centered(confirmation, width);
    await expect(
      confirmation.getByRole('button', { name: '계속 편집', exact: true })
    ).toBeFocused();
    await page.screenshot({ path: info.outputPath(`bookmark-discard-${width}.png`) });
    await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(close).toBeFocused();
    await expect(editor.getByLabel('책갈피 이름')).toHaveValue('저장하지 않은 이름');
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirmation).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(navigator).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(confirmation).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(confirmation).not.toBeVisible();
    await expect(editor.getByLabel('책갈피 메모')).toHaveValue('취소해도 남아야 하는 메모');
    expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);
    await close.click();
    await confirmation.getByRole('button', { name: '수정 버리고 닫기', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(navigator).toBeVisible();
    await expect(opener).toBeFocused();
    expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);

    await opener.click();
    await editor.getByLabel('책갈피 이름').fill('직접 저장한 이름');
    await editor.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(list.getByRole('button', { name: '직접 저장한 이름', exact: true })).toBeVisible();
    const savedOpener = list.getByRole('button', {
      name: '직접 저장한 이름 책갈피 편집',
      exact: true,
    });
    await savedOpener.click();
    await editor.getByLabel('책갈피 메모').fill('닫을 때 저장한 메모');
    await close.click();
    await confirmation.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await expect(savedOpener).toBeFocused();
    expect(await savedBookmarks(request, chat.id)).toMatchObject([
      {
        id: bookmark.id,
        revision: bookmark.revision + 2,
        title: '직접 저장한 이름',
        note: '닫을 때 저장한 메모',
      },
    ]);
    expect(native).toEqual([]);
  });

  test(`BMCONF02 bookmark save conflicts and in-flight dismissal never lose a draft or duplicate a request at ${width}`, async ({
    page,
    request,
  }) => {
    const { chat, bookmark } = await seedBookmark(request, width);
    const native = nativeDialogs(page);
    await page.setViewportSize({ width, height: 900 });
    const { list } = await openBookmarks(page, chat.id);
    await list.getByRole('button', { name: `${bookmark.title} 책갈피 편집`, exact: true }).click();
    const editor = page.locator('dialog.bookmark-dialog');
    const confirmation = page.getByRole('alertdialog', { name: '미저장 책갈피 확인', exact: true });
    await editor.getByLabel('책갈피 메모').fill('충돌해도 남는 초안');
    const changed = await request.patch(`/api/bookmarks/${bookmark.id}`, {
      data: {
        expectedRevision: bookmark.revision,
        title: '다른 기기의 이름',
        note: '다른 기기의 메모',
      },
    });
    expect(changed.ok()).toBe(true);
    const latest = (await changed.json()) as Bookmark;
    await editor.getByRole('button', { name: '책갈피 변경 저장', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('(409)');
    await expect(editor.getByLabel('책갈피 메모')).toHaveValue('충돌해도 남는 초안');
    await editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true }).click();
    await confirmation.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('(409)');
    await expect(confirmation).toBeVisible();
    expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
    await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(editor.getByLabel('책갈피 메모')).toHaveValue('충돌해도 남는 초안');
    await editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true }).click();
    await confirmation.getByRole('button', { name: '수정 버리고 닫기', exact: true }).click();
    await list.getByRole('button', { name: '책갈피 새로 고침', exact: true }).click();
    await list.getByRole('button', { name: `${latest.title} 책갈피 편집`, exact: true }).click();
    await editor.getByLabel('책갈피 이름').fill('   ');
    await expect(
      editor.getByRole('button', { name: '책갈피 변경 저장', exact: true })
    ).toBeDisabled();
    await editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true }).click();
    await confirmation.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('책갈피 이름을 입력해 주세요');
    expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
    await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
    await editor.getByLabel('책갈피 이름').fill('안전하게 저장된 이름');
    await editor.getByRole('button', { name: '책갈피 편집 닫기', exact: true }).click();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const patches: unknown[] = [];
    const path = `/api/bookmarks/${bookmark.id}`;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patches.push(route.request().postDataJSON());
      await held;
      await route.continue();
    });
    try {
      await confirmation.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
      await expect.poll(() => patches.length).toBe(1);
      await expect(
        confirmation.getByRole('button', { name: '계속 편집', exact: true })
      ).toBeDisabled();
      await expect(
        confirmation.getByRole('button', { name: '수정 버리고 닫기', exact: true })
      ).toBeDisabled();
      await expect(
        confirmation.getByRole('button', { name: '저장 중…', exact: true })
      ).toBeDisabled();
      await confirmation
        .getByRole('button', { name: '미저장 책갈피 확인 닫기', exact: true })
        .click();
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);
      await expect(confirmation).toBeVisible();
      await expect(editor).toBeVisible();
      // A second submit in the same pending save must also be rejected by the save lock.
      await editor.locator('form').evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
      expect(patches).toEqual([
        { expectedRevision: latest.revision, title: '안전하게 저장된 이름', note: latest.note },
      ]);
      expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
      release();
      await expect(editor).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      expect(await savedBookmarks(request, chat.id)).toMatchObject([
        { id: latest.id, title: '안전하게 저장된 이름', revision: latest.revision + 1 },
      ]);
      expect(patches).toHaveLength(1);
    } finally {
      release();
      await page.unroute(`**${path}`);
    }
    expect(native).toEqual([]);
  });

  test(`BMCONF03 bookmark deletion cancellation, stale revision and busy guard preserve the manuscript at ${width}`, async ({
    page,
    request,
  }, info) => {
    const { chat, bookmark } = await seedBookmark(request, width);
    const native = nativeDialogs(page);
    const before = await (await request.get(`/api/chats/${chat.id}/transcript`)).json();
    await page.setViewportSize({ width, height: 900 });
    const { navigator, list } = await openBookmarks(page, chat.id);
    const opener = list.getByRole('button', { name: `${bookmark.title} 책갈피 삭제`, exact: true });
    const confirmation = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
    await opener.click();
    await centered(confirmation, width);
    await expect(confirmation).toContainText('책갈피만 삭제해요. 원고는 유지돼요.');
    await page.screenshot({ path: info.outputPath(`bookmark-delete-${width}.png`) });
    await confirmation.getByRole('button', { name: '취소', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await page.keyboard.press('Escape');
    await expect(confirmation).not.toBeVisible();
    await expect(navigator).toBeVisible();
    await expect(opener).toBeFocused();
    await opener.click();
    await page.mouse.click(5, 5);
    await expect(confirmation).not.toBeVisible();
    await expect(opener).toBeFocused();
    expect(await savedBookmarks(request, chat.id)).toEqual([bookmark]);

    await opener.click();
    const changed = await request.patch(`/api/bookmarks/${bookmark.id}`, {
      data: {
        expectedRevision: bookmark.revision,
        title: '다른 기기에서 수정한 책갈피',
        note: bookmark.note,
      },
    });
    expect(changed.ok()).toBe(true);
    const latest = (await changed.json()) as Bookmark;
    await confirmation.getByRole('button', { name: '영구 삭제', exact: true }).click();
    await expect(confirmation.getByRole('alert')).toContainText('책갈피가 변경됐어요');
    expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
    await confirmation.getByRole('button', { name: '취소', exact: true }).click();
    await list.getByRole('button', { name: '책갈피 새로 고침', exact: true }).click();
    await list.getByRole('button', { name: `${latest.title} 책갈피 삭제`, exact: true }).click();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletions: unknown[] = [];
    const path = `/api/bookmarks/${bookmark.id}`;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      deletions.push(route.request().postDataJSON());
      await held;
      await route.continue();
    });
    try {
      await confirmation.getByRole('button', { name: '영구 삭제', exact: true }).click();
      await expect.poll(() => deletions.length).toBe(1);
      await expect(confirmation.getByRole('button', { name: '취소', exact: true })).toBeDisabled();
      await expect(
        confirmation.getByRole('button', { name: '삭제 중…', exact: true })
      ).toBeDisabled();
      await confirmation.getByRole('button', { name: '삭제 확인 닫기', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);
      await expect(confirmation).toBeVisible();
      expect(await savedBookmarks(request, chat.id)).toEqual([latest]);
      expect(deletions).toEqual([{ expectedRevision: latest.revision }]);
      release();
      await expect(confirmation).not.toBeVisible();
      await expect(list).toContainText('아직 책갈피가 없어요');
      await expect(navigator).toBeVisible();
      expect(await savedBookmarks(request, chat.id)).toEqual([]);
      expect(deletions).toHaveLength(1);
      const after = await (await request.get(`/api/chats/${chat.id}/transcript`)).json();
      expect(after.entries).toEqual(before.entries);
    } finally {
      release();
      await page.unroute(`**${path}`);
    }
    expect(native).toEqual([]);
  });
}
