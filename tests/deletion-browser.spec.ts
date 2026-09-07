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
  await page.getByTestId('library-panel').getByRole('tab', { name: tab, exact: true }).click();
  return page.getByTestId('library-panel');
}

test('DEL01 library cancel, stale revision, dependent bot and actual deletion at mobile width', async ({
  page,
  request,
}, info) => {
  const item = await content(request);
  const panel = await library(page, '봇');
  await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '삭제 확인', exact: true });
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect((await request.get(`/api/revisions/content/${item.id}/1`)).ok()).toBe(true);
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
  await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
  await confirm(page);
  await expect(dialog.getByRole('alert')).toContainText('변경');
  await page.keyboard.press('Escape');
  await page.reload();
  await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
  await page.screenshot({ path: info.outputPath('delete-confirm-mobile.png') });
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
  await panel.getByRole('button', { name: `${owner.title} 삭제`, exact: true }).click();
  await confirm(page);
  await expect(dialog.getByRole('alert')).toContainText('봇 소속 채팅');
});

test('DEL02 prompt combinations and presets have deletion and removed prompt does not reappear', async ({
  page,
  request,
}) => {
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
      prompt: { id: prompt.id, revision: prompt.revision },
      values: {},
    },
  });
  expect(combinationResponse.ok()).toBe(true);
  const panel = await library(page, '프롬프트');
  await panel.getByLabel('불러올 프롬프트', { exact: true }).selectOption(`${prompt.id}@1`);
  await panel.getByText('저장된 창작 조합·프리셋 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '삭제 전역 조합 삭제', exact: true }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: '삭제 전역 조합 삭제', exact: true })).toHaveCount(
    0
  );
  await panel.getByRole('button', { name: `${prompt.title} 프롬프트 삭제`, exact: true }).click();
  await confirm(page);
  await expect(panel.getByLabel('불러올 프롬프트', { exact: true })).toHaveValue('builtin');
  await expect(
    panel
      .getByLabel('불러올 프롬프트', { exact: true })
      .getByRole('option', { name: new RegExp(prompt.title) })
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
  await nav.getByRole('button', { name: `${chat.title} 채팅 삭제`, exact: true }).click();
  await confirm(page);
  await expect(nav.getByRole('button', { name: chat.title, exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(chat.id));
  expect((await request.get(`/api/chats/${chat.id}`)).status()).toBe(404);
  expect((await request.get(`/api/chats/${preserved.id}`)).ok()).toBe(true);
  await expect(other).not.toHaveURL(new RegExp(chat.id));
  await other.close();
});

test('DEL04 other standalone content kinds are discoverable and deletable', async ({
  page,
  request,
}) => {
  const items = await Promise.all(
    ['lore', 'canon', 'skill', 'glossary', 'persona', 'module'].map((kind) =>
      content(request, kind)
    )
  );
  const panel = await library(page, '기타 자료');
  for (const item of items.filter((item) =>
    ['lore', 'canon', 'skill', 'glossary'].includes(item.kind)
  )) {
    await panel.getByRole('button', { name: `${item.title} 삭제`, exact: true }).click();
    await confirm(page);
    await expect(
      panel.getByRole('button', { name: `${item.title} 삭제`, exact: true })
    ).toHaveCount(0);
  }
  for (const [kind, label] of [
    ['persona', '페르소나'],
    ['module', '모듈'],
  ]) {
    await panel.getByRole('tab', { name: label, exact: true }).click();
    const item = items.find((item) => item.kind === kind)!;
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
        enabled: false,
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
      enabled: false,
    },
  });
  expect(response.ok()).toBe(true);
  const model = await response.json();
  await page.goto('/');
  await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
  await page.getByRole('button', { name: '설정', exact: true }).filter({ visible: true }).click();
  await page.getByRole('tab', { name: '연결과 모델', exact: true }).click();
  const editor = page.getByTestId('connection-editor');
  await editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true }).click();
  await confirm(page);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole('button', { name: `${model.title} 모델 삭제`, exact: true })
  ).toHaveCount(0);
  await editor.getByRole('button', { name: '연결 관리', exact: true }).click();
  await editor.getByRole('button', { name: `${connection.title} 연결 삭제`, exact: true }).click();
  await confirm(page);
  await expect(
    editor.getByRole('button', { name: `${connection.title} 연결 삭제`, exact: true })
  ).toHaveCount(0);
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
  await page.getByRole('button', { name: '보관된 전개', exact: true }).click();
  const panel = page.getByRole('region', { name: '보관된 전개 목록', exact: true });
  await panel.getByRole('button', { name: /분기 삭제$/ }).click();
  await confirm(page);
  await expect(panel.getByRole('button', { name: /분기 삭제$/ })).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(branch.id));
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.branches).toHaveLength(1);
});
