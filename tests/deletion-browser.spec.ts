import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { setCurrentModels } from './ui-navigation.js';
import { visualReview } from './fixtures/visual-review.js';
import {
  openProviderMenu,
  selectSettingsSection,
  editLibraryContent,
  navigationAction,
  openPromptActions,
  openChatMenu,
} from './ui-navigation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Content, Library } from '../core/product.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';

async function content(request: APIRequestContext, kind = 'bot') {
  const response = await request.post('/api/content', {
    data: {
      kind,
      title: `삭제 합성 ${kind} ${crypto.randomUUID()}`,
      description: '삭제 확인용',
      text: 'Synthetic',
      loading: 'pinned',
      relatedIds: [],
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Content>;
}
async function confirm(page: Page) {
  await page
    .getByRole('alertdialog', { name: '삭제 확인', exact: true })
    .getByRole('button', { name: '영구 삭제', exact: true })
    .click();
}
async function library(page: Page, tab: string) {
  await page.goto('/');
  await navigationAction(page, tab);
  return page.getByTestId(tab === '프롬프트' ? 'prompt-library' : 'library-panel');
}

test('DEL01 library cancel, stale revision, dependent bot and actual deletion at mobile width', async ({
  page,
  request,
  browser,
}, info) => {
  const item = await content(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await library(page, '봇');
  await panel.getByLabel('목록 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '카드', exact: true }).click();
  await panel.getByLabel('목록 관리', { exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  const card = panel
    .locator('.library-card')
    .filter({ has: page.getByRole('button', { name: `${item.title} 상세 보기`, exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: `${item.title} 삭제`, exact: true })).toBeHidden();
  await card.getByLabel(`${item.title} 메뉴`, { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: `${item.title} 삭제`, exact: true })).toBeVisible();
  if (visualReview)
    await page.screenshot({ path: info.outputPath('library-card-delete-desktop.png') });
  const touchContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'dark',
  });
  try {
    const touchPage = await touchContext.newPage();
    const touchPanel = await library(touchPage, '봇');
    await touchPanel.getByLabel('목록 관리', { exact: true }).click();
    await touchPanel.getByRole('button', { name: '카드', exact: true }).click();
    await touchPanel.getByLabel('목록 관리', { exact: true }).click();
    await touchPanel.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
    await expect(
      touchPanel.getByRole('button', { name: `${item.title} 삭제`, exact: true })
    ).toBeVisible();
    if (visualReview)
      await touchPage.screenshot({ path: info.outputPath('library-card-delete-touch.png') });
  } finally {
    await touchContext.close();
  }
  await card.getByLabel(`${item.title} 메뉴`, { exact: true }).press('Escape');
  await editLibraryContent(page, item.title);
  await expect(panel.getByRole('region', { name: '자료 상세', exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const width of visualReview ? [960, 390] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`content-header-${width}.png`) });
  }
  await panel.getByLabel('자료 메뉴', { exact: true }).click();
  await panel.getByRole('button', { name: `${item.title} 자료 삭제`, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect((await request.get(`/api/revisions/content/${item.id}/1`)).ok()).toBe(true);
  await panel.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  const changed = await request.put(`/api/content/${item.id}`, {
    data: {
      kind: item.kind,
      title: item.title,
      description: item.description,
      text: 'Changed',
      loading: item.loading,
      relatedIds: [],
      expectedRevision: 1,
    },
  });
  expect(changed.ok()).toBe(true);
  await panel.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
  await confirm(page);
  await expect(dialog.getByRole('alert')).toContainText('변경');
  await page.keyboard.press('Escape');
  await page.reload();
  await panel.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
  if (visualReview) await page.screenshot({ path: info.outputPath('delete-confirm-mobile.png') });
  expect(
    await dialog.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)
  ).toBe(true);
  await confirm(page);
  await expect(panel.getByRole('button', { name: `${item.title} 삭제`, exact: true })).toHaveCount(
    0
  );
  expect((await request.get(`/api/revisions/content/${item.id}/1`)).status()).toBe(404);
  const owner = await content(request);
  expect(
    (await request.post('/api/chats', { data: { title: '참조 검사 채팅', botId: owner.id } })).ok()
  ).toBe(true);
  await page.reload();
  await panel.getByLabel(`${owner.title} 메뉴`, { exact: true }).click();
  await panel.getByRole('button', { name: `${owner.title} 삭제`, exact: true }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: `${owner.title} 삭제`, exact: true })).toHaveCount(
    0
  );
  expect((await request.get(`/api/content/${owner.id}`)).status()).toBe(404);
});

test('DEL02 prompt combinations and presets have deletion and removed prompt does not reappear', async ({
  page,
  request,
}, info) => {
  const response = await request.post('/api/prompt-presets', {
    data: {
      title: `삭제 프롬프트 ${crypto.randomUUID()}`,
      role: 'main',
      program: createDefaultPromptProgram('Synthetic', 'main'),
    },
  });
  expect(response.ok()).toBe(true);
  const prompt = await response.json();
  const combinationResponse = await request.post('/api/prompt-combinations', {
    data: {
      title: '삭제 전역 조합',
      role: 'main',
      owner: { kind: 'preset', id: prompt.id },
      expectedRevision: prompt.revision,
      values: {},
    },
  });
  expect(combinationResponse.ok()).toBe(true);
  const panel = await library(page, '프롬프트');
  await panel.getByRole('button', { name: `${prompt.title} 프롬프트 편집`, exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const width of visualReview ? [960, 390] : [390]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.locator('.prompt-saved-management').scrollIntoViewIfNeeded();
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`prompt-footer-${width}.png`) });
  }

  await panel.getByText('이 프롬프트의 옵션 조합 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '삭제 전역 조합 삭제', exact: true }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: '삭제 전역 조합 삭제', exact: true })).toHaveCount(
    0
  );
  await openPromptActions(panel);
  await panel.getByRole('button', { name: `${prompt.title} 프롬프트 삭제`, exact: true }).click();
  await confirm(page);
  await expect(
    panel.getByRole('button', { name: `${prompt.title} 프롬프트 삭제`, exact: true })
  ).toHaveCount(0);
  await panel.getByRole('button', { name: '← 프롬프트 목록', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: `${prompt.title} 프롬프트 편집`, exact: true })
  ).toHaveCount(0);
  await page.reload();
  const data: Library = await (await request.get('/api/library')).json();
  expect(data.promptPresets?.some((item) => item.id === prompt.id)).toBe(false);
});

test('DEL03 deleting selected chat clears reader and URL while preserving another chat', async ({
  page,
  request,
}) => {
  const owner = await content(request);
  const response = await request.post('/api/chats', {
    data: { title: `삭제 채팅 ${crypto.randomUUID()}`, botId: owner.id },
  });
  const chat = await response.json();
  const preserved = await (
    await request.post('/api/chats', { data: { title: '남기는 채팅', botId: owner.id } })
  ).json();
  const other = await page.context().newPage();
  await other.goto(`/?chat=${chat.id}`);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  const nav = page.getByTestId('bot-navigation').filter({ visible: true });
  await nav.locator(`[data-chat-id="${chat.id}"]`).hover();
  await nav.getByRole('button', { name: `${chat.title} 채팅 삭제`, exact: true }).click();
  await confirm(page);
  await expect(nav.getByRole('button', { name: chat.title, exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(chat.id));
  expect((await request.get(`/api/chats/${chat.id}`)).status()).toBe(404);
  expect((await request.get(`/api/chats/${preserved.id}`)).ok()).toBe(true);
  await expect(other).not.toHaveURL(new RegExp(chat.id));
  await other.close();
});

test('DEL04 personas and modules remain deletable from their own categories', async ({
  page,
  request,
}) => {
  // Invalid retired kinds are covered at creation/archive boundaries in library-organization.test.ts.
  const items = await Promise.all(['persona', 'module'].map((kind) => content(request, kind)));
  const panel = await library(page, '페르소나');
  await expect(panel.getByRole('tab', { name: '기타 자료', exact: true })).toHaveCount(0);
  for (const [kind, label] of [
    ['persona', '페르소나'],
    ['module', '모듈'],
  ]) {
    await panel.getByRole('tab', { name: label, exact: true }).click();
    const item = items.find((item) => item.kind === kind)!;
    await panel.getByLabel(`${item.title} 메뉴`, { exact: true }).click();
    await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
    await confirm(page);
    expect((await request.get(`/api/revisions/content/${item.id}/1`)).status()).toBe(404);
  }
});

test('DEL05 model is deleted before its connection and settings lists stay current', async ({
  page,
  request,
}) => {
  const connection = await (
    await request.post('/api/connections', {
      data: {
        title: `삭제 연결 ${crypto.randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9/',
        enabled: true,
      },
    })
  ).json();
  const response = await request.post('/api/model-presets', {
    data: {
      title: `삭제 모델 ${crypto.randomUUID()}`,
      connectionId: connection.id,
      modelId: 'synthetic',
      maxOutputTokens: 4096,
      temperature: null,
      enabled: true,
    },
  });
  expect(response.ok()).toBe(true);
  const model = await response.json();
  const chat = await (
    await postFixtureChat(request, { data: { title: '전역 모델 삭제 반영' } })
  ).json();
  await setCurrentModels(request, { main: { id: model.id } });
  await page.goto(`/?chat=${chat.id}`);
  const chip = page.getByRole('button', { name: /^현재 본문 모델/ });
  await expect(chip).toContainText(model.title);
  const other = await page.context().newPage();
  await other.goto(`/?chat=${chat.id}`);
  await expect(other.getByRole('button', { name: /^현재 본문 모델/ })).toContainText(model.title);
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await page.getByRole('button', { name: '설정', exact: true }).filter({ visible: true }).click();
  await selectSettingsSection(page, '연결과 모델');
  const editor = page.getByTestId('connection-editor');
  await openProviderMenu(page, '모델', model.title);
  await editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await openProviderMenu(page, '모델', model.title);
  await editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true }).click();
  await confirm(page);
  await expect(editor).toBeVisible();
  await expect
    .poll(async () => (await (await request.get('/api/model-workspace')).json()).routes.main)
    .toBeNull();
  await expect(other.getByRole('button', { name: /^현재 본문 모델/ })).toContainText(
    '본문 모델을 선택해 주세요'
  );
  await expect(
    editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true })
  ).toHaveCount(0);
  await editor.getByRole('button', { name: '연결 관리', exact: true }).click();
  await openProviderMenu(page, '연결', connection.title);
  await editor.getByRole('button', { name: `${connection.title} 연결 삭제`, exact: true }).click();
  await confirm(page);
  await expect(
    editor.getByRole('button', { name: `${connection.title} 연결 삭제`, exact: true })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(chip).toContainText('본문 모델을 선택해 주세요');
  await other.close();
});

test('DEL06 deleting the displayed branch returns to the default branch', async ({
  page,
  request,
}) => {
  const chat = await (
    await postFixtureChat(request, { data: { title: `분기 삭제 ${crypto.randomUUID()}` } })
  ).json();
  const response = await request.post(`/api/chats/${chat.id}/branches`, {
    data: { title: '삭제할 전개', fromRevision: null },
  });
  expect(response.ok()).toBe(true);
  const branch = await response.json();
  await page.goto(`/?chat=${chat.id}&branch=${branch.id}`);
  await openChatMenu(page);
  await page.getByRole('button', { name: '보관된 전개', exact: true }).click();
  const panel = page.getByRole('region', { name: '보관된 전개 목록', exact: true });
  await panel.getByRole('button', { name: /분기 삭제$/ }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: /분기 삭제$/ })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(branch.id));
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.branches).toHaveLength(1);
});

preservePromptWorkspace();
