import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ContextDetail as Detail, ContextJob } from '../core/context-plan.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { StoryDetail } from '../core/story.js';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { selectChatSettingsSection } from './ui-navigation.js';
import { openChatSettings } from './ui-navigation.js';

async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function create(page: Page, title: string) {
  // Summary edits measure the selected main input budget; these tests never send a provider call.
  // Keep the summary workflow independent of the size of the bundled writing prompt.
  const prompts = await read<PromptWorkspace>(page.request, '/prompt-workspace');
  const configured = await page.request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: prompts.revision,
      main: {
        title: 'Synthetic context instructions',
        program: createDefaultPromptProgram(DEFAULT_MAIN_PROMPT),
        values: {},
      },
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const connectionResponse = await page.request.post('/api/connections', {
    data: {
      title: `${title} 합성 연결`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
  const connection = await connectionResponse.json();
  const modelResponse = await page.request.post('/api/model-presets', {
    data: {
      title: `${title} 합성 본문 모델`,
      connectionId: connection.id,
      modelId: 'synthetic-context-ui-main',
      inputTokenLimit: 8192,
      maxOutputTokens: 1000,
      temperature: null,
    },
  });
  expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
  const model = await modelResponse.json();
  const workspace = await read<ModelWorkspace>(page.request, '/model-workspace');
  const selected = await page.request.put('/api/model-workspace', {
    data: {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: { id: model.id } },
      translationPolicy: workspace.translationPolicy,
    },
  });
  expect(selected.ok(), await selected.text()).toBe(true);
  const response = await postFixtureChat(page.request, { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = (await response.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '상태와 문맥');
  const panel = page.getByTestId('context-panel');
  await expect(panel.getByRole('button', { name: '요약 작성', exact: true })).toBeEnabled();
  return { chat, panel };
}
async function saveSummary(request: APIRequestContext, chatId: string, summary: string) {
  const detail = await read<Detail>(request, `/chats/${chatId}/context`);
  const response = await request.put(`/api/chats/${chatId}/context/summary`, {
    data: {
      expectedRevision: detail.activeRevision,
      expectedHeadRevision: detail.headRevision,
      idempotencyKey: randomUUID(),
      summary,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Detail>;
}
async function assertBounds(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  const panel = page.getByTestId('context-panel');
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

test('CTXUI01 summary authoring without a Run, edit and restore are durable at both widths', async ({
  page,
  request,
}, info) => {
  const { chat, panel } = await create(page, 'CTXUI01 합성 요약');
  await panel.getByRole('button', { name: '요약 작성', exact: true }).click();
  await panel.getByLabel('편집할 문맥 요약').fill('첫 요약: 항구의 종이 울렸다.');
  await panel.getByRole('button', { name: '요약 저장', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '첫 요약: 항구의 종이 울렸다.'
  );
  await panel.getByRole('button', { name: '요약 편집', exact: true }).click();
  await panel.getByLabel('편집할 문맥 요약').fill('두 번째 요약: 배가 출발했다.');
  await panel.getByRole('button', { name: '요약 저장', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '두 번째 요약: 배가 출발했다.'
  );
  await panel.locator('.context-history > summary').click();
  const old = panel
    .locator('.context-history li')
    .filter({ hasText: '첫 요약: 항구의 종이 울렸다.' });
  await old.getByRole('button', { name: '이 요약으로 되돌리기', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '첫 요약: 항구의 종이 울렸다.'
  );
  const saved = await read<Detail>(request, `/chats/${chat.id}/context`);
  expect(saved.activeRevision).toBe(3);
  expect(saved.checkpoints).toHaveLength(3);
  expect((await read<ChatDetail>(request, `/chats/${chat.id}`)).runs).toEqual([]);
  expect(await read<unknown[]>(request, `/chats/${chat.id}/attempts`)).toEqual([]);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await assertBounds(page);
    await page.screenshot({ path: info.outputPath(`context-summary-${width}.png`) });
  }
  await page.reload();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '상태와 문맥');
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '첫 요약: 항구의 종이 울렸다.'
  );
});

test('CTXUI02 concurrent summary and note changes preserve local drafts and require explicit rebase', async ({
  page,
  request,
}) => {
  const { chat, panel } = await create(page, 'CTXUI02 합성 충돌');
  await panel.getByRole('button', { name: '요약 작성', exact: true }).click();
  await panel.getByLabel('편집할 문맥 요약').fill('내 요약 초안');
  await saveSummary(request, chat.id, '다른 창에서 저장한 요약');
  await panel.getByRole('button', { name: '새로 확인', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText('다른 창에서 저장한 요약');
  await expect(panel.getByLabel('편집할 문맥 요약')).toHaveValue('내 요약 초안');
  await expect(panel.getByRole('button', { name: '요약 저장', exact: true })).toBeDisabled();
  await panel
    .getByRole('button', { name: '최신 요약을 확인했어요 · 내 초안 유지', exact: true })
    .click();
  await panel.getByRole('button', { name: '요약 저장', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText('내 요약 초안');
  const notes = panel.getByTestId('context-notes');
  await notes.locator(':scope > summary').click();
  await notes.getByRole('button', { name: '메모 추가', exact: true }).click();
  await notes.getByLabel('메모·정정 내용').fill('내 메모 초안');
  const before = await read<StoryDetail>(request, `/chats/${chat.id}/story`);
  const added = await request.post(`/api/chats/${chat.id}/notes`, {
    data: {
      expectedRevision: before.notesRevision,
      expectedHeadRevision: null,
      idempotencyKey: randomUUID(),
      author: '다른 작가',
      text: '다른 창의 메모',
    },
  });
  expect(added.ok(), await added.text()).toBe(true);
  await panel.getByRole('button', { name: '새로 확인', exact: true }).click();
  await expect(notes.getByText('다른 창의 메모', { exact: true })).toBeVisible();
  await expect(notes.getByLabel('메모·정정 내용')).toHaveValue('내 메모 초안');
  await expect(notes.getByRole('button', { name: '새 메모 저장', exact: true })).toBeDisabled();
  // A mobile section-back changes visibility only, preserving text and its conflict state.
  await page.getByRole('button', { name: '채팅 설정 목록으로', exact: true }).click();
  await selectChatSettingsSection(page, '이 채팅의 모델');
  await selectChatSettingsSection(page, '상태와 문맥');
  await expect(notes.getByLabel('메모·정정 내용')).toHaveValue('내 메모 초안');
  await notes
    .getByRole('button', { name: '최신 내용을 확인했어요 · 내 초안 유지', exact: true })
    .click();
  await notes.getByRole('button', { name: '새 메모 저장', exact: true }).click();
  await expect
    .poll(async () =>
      (await read<StoryDetail>(request, `/chats/${chat.id}/story`)).notes
        .map((note) => note.text)
        .sort()
    )
    .toEqual(['내 메모 초안', '다른 창의 메모'].sort());
  expect((await read<ChatDetail>(request, `/chats/${chat.id}`)).sources).toEqual([]);
  expect(await read<unknown[]>(request, `/chats/${chat.id}/attempts`)).toEqual([]);
});

test('CTXUI03 manual no-op preserves a summary and exposes cancellable running-job projection', async ({
  page,
  request,
}) => {
  const { chat, panel } = await create(page, 'CTXUI03 합성 압축 상태');
  await saveSummary(request, chat.id, '보존할 요약');
  await panel.getByRole('button', { name: '새로 확인', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText('보존할 요약');
  await panel.getByRole('button', { name: '지금 압축', exact: true }).click();
  await expect(
    panel.getByText('정리할 구간이 없어 원문과 요약을 유지했어요.', { exact: true })
  ).toBeVisible();
  const actual = await read<Detail>(request, `/chats/${chat.id}/context`);
  expect(actual.jobs[0]).toMatchObject({ status: 'completed', noop: true });
  expect(actual.checkpoint?.plan.summary).toBe('보존할 요약');
  expect(await read<unknown[]>(request, `/chats/${chat.id}/attempts`)).toEqual([]);
  // Cancellation interaction is a UI projection; durable cancellation is covered by ContextStore tests.
  const job = {
    ...actual.jobs[0],
    id: 'synthetic-running-context',
    status: 'running' as ContextJob['status'],
    noop: false,
    error: null,
  };
  await page.route(`**/api/chats/${chat.id}/context?*`, (route) =>
    route.fulfill({ json: { ...actual, jobs: [job] } })
  );
  let cancellations = 0;
  await page.route(`**/api/chats/${chat.id}/context/jobs/${job.id}/cancel`, async (route) => {
    expect(route.request().method()).toBe('POST');
    cancellations++;
    job.status = 'cancelled';
    await route.fulfill({ json: job });
  });
  await panel.getByRole('button', { name: '새로 확인', exact: true }).click();
  await expect(panel.getByRole('button', { name: '압축 취소', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '압축 취소', exact: true }).click();
  await expect(
    panel.getByText('압축을 취소했어요. 마지막 유효한 요약을 유지해요.', { exact: true })
  ).toBeVisible();
  await expect(panel.getByTestId('context-summary-text')).toHaveText('보존할 요약');
  expect(cancellations).toBe(1);
  expect((await read<Detail>(request, `/chats/${chat.id}/context`)).jobs[0].status).toBe(
    'completed'
  );
});

preservePromptWorkspace();
