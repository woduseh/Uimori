import { nativeContent } from './fixtures/native-content.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { waitForContentSave } from './fixtures/resource-save.js';
import {
  createLibraryContent,
  editLibraryContent,
  editorSectionNames,
  selectEditorSection,
} from './ui-navigation.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Content } from '../core/product.js';

async function seedBot(request: APIRequestContext, title: string) {
  const description = '낯선 도시를 함께 탐험할 합성 안내자예요.';
  const response = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description,
      package: nativeContent({
        name: title,
        description: 'Synthetic guide for local browser verification.',
        creator_notes: description,
      }),
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const created = (await response.json()) as Content;
  expect(created.description).toBe(description);
  return created;
}

for (const [index, width] of (visualReview ? [MOBILE_WIDTH, 360] : [MOBILE_WIDTH]).entries()) {
  test(`LUSE0${index + 1} mobile ${width}px library list view keeps readable rows and creates a bot into a chat`, async ({
    page,
    request,
  }, info) => {
    const title = `LUSE ${width} ${Date.now()}`;
    const seed = await seedBot(request, `${title} 안내자`);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const panel = page.getByTestId('library-panel');
    await panel.getByLabel('서재 검색', { exact: true }).fill(title);
    await panel.getByRole('button', { name: '목록', exact: true }).click();
    const row = panel.locator('.library-list-item');
    await expect(row).toHaveCount(1);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-readable-${width}.png`) });

    await row.getByRole('button', { name: `${seed.title} 편집`, exact: true }).click();
    await expect(panel.getByLabel('봇 이름', { exact: true })).toHaveValue(seed.title);
    await expect(panel.getByLabel('제작자 코멘트', { exact: true })).toHaveValue(seed.description);
    await panel.getByRole('button', { name: '서재 목록', exact: true }).click();

    await createLibraryContent(page);
    const saveState = panel.locator('.resource-editor-status').getByRole('status');
    await expect(saveState).toHaveText('등록 전');
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-create-${width}.png`) });
    const createdTitle = `${title} 새 친구`,
      body = '친절한 안내자예요. 내가 고른 길을 존중하며 짧게 대답해요.';
    await panel.getByLabel('Risu 자료 이름', { exact: true }).fill(createdTitle);
    await panel.getByLabel('카드 설명', { exact: true }).fill(body);
    await expect(saveState).toHaveText('미저장 변경');
    const savedResponse = waitForContentSave(page);
    const register = panel.getByRole('button', { name: '자료 등록', exact: true });
    await expect(register).toHaveText('등록');
    await register.click();
    const saved = await savedResponse;
    expect(saved.text).toBe(body);
    expect(saved.package?.body).toBe(body);
    const start = panel.getByRole('button', { name: '채팅 시작', exact: true });
    await expect(start).toBeEnabled();
    await expect(panel.getByRole('heading', { name: createdTitle, exact: true })).toBeVisible();
    await expect(saveState).toBeEmpty();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`library-saved-${width}.png`) });
    await start.click();
    const dialog = page.getByRole('dialog', { name: '새 채팅', exact: true });
    const createdResponse = page.waitForResponse(
      (reply) => reply.url().endsWith('/api/chats') && reply.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '채팅 만들기', exact: true }).click();
    const created = await createdResponse;
    expect(created.ok(), await created.text()).toBe(true);
    const chat = await created.json();
    await expect(dialog).toBeHidden();
    const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(detail.chat.botId).toBe(saved.id);
    expect(detail.runs).toHaveLength(0);
  });
}

test('LUSE04 standalone module navigation omits bot-only panes and retains its source', async ({
  page,
  request,
}) => {
  const title = `LUSE04 module ${crypto.randomUUID()}`;
  const pkg = nativeContent({ name: title }, {}, 'module');
  pkg.nativeRisu.card = {};
  pkg.nativeRisu.module = { name: title, defaultVariables: 'place=forest', preserved: 'source' };
  const response = await request.post('/api/content', {
    data: { kind: 'module', title, package: pkg, loading: 'pinned', relatedIds: [] },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const saved = (await response.json()) as Content;
  await page.goto('/');
  const panel = page.getByTestId('library-panel');
  await panel.getByRole('tab', { name: '모듈', exact: true }).click();
  await panel.getByLabel('서재 검색', { exact: true }).fill(title);
  await editLibraryContent(page, title);
  const sections = await editorSectionNames(panel);
  for (const botOnly of ['첫 메시지', '추가 지침', '배경 HTML과 CSS', '이미지 지침'])
    expect(sections).not.toContain(botOnly);
  await selectEditorSection(panel, '변수와 토글 초기값');
  await expect(panel.getByRole('textbox', { name: '기본 변수', exact: true })).toHaveValue(
    'place=forest'
  );
  const retained = (await (await request.get(`/api/content/${saved.id}`)).json()) as Content;
  expect(retained.revision).toBe(saved.revision);
  expect(retained.package?.nativeRisu.module).toMatchObject({
    defaultVariables: 'place=forest',
    preserved: 'source',
  });
});
