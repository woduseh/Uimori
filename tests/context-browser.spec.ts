import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ContextDetail as Detail } from '../core/context-plan.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
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
  const prompts = await read<PromptWorkspace>(page.request, '/prompt-workspace');
  const configured = await page.request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: prompts.revision,
      main: {
        title: 'Synthetic context instructions',
        program: createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT),
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
  await selectChatSettingsSection(page, '기억과 메모');
  const panel = page.getByTestId('context-panel');
  await expect(panel.getByRole('button', { name: '직접 요약 작성', exact: true })).toBeEnabled();
  return { chat, panel };
}
test('CTXUI01 summary authoring without a Run, edits replace the current summary durably', async ({
  page,
  request,
}) => {
  const { chat, panel } = await create(page, 'CTXUI01 합성 요약');
  await panel.getByRole('button', { name: '직접 요약 작성', exact: true }).click();
  await panel.getByLabel('편집할 컨텍스트 요약').fill('첫 요약: 항구의 종이 울렸다.');
  await panel.getByRole('button', { name: '요약 저장', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '첫 요약: 항구의 종이 울렸다.'
  );
  await panel.getByRole('button', { name: '요약 편집', exact: true }).click();
  await panel.getByLabel('편집할 컨텍스트 요약').fill('두 번째 요약: 배가 출발했다.');
  await panel.getByRole('button', { name: '요약 저장', exact: true }).click();
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '두 번째 요약: 배가 출발했다.'
  );
  const saved = await read<Detail>(request, `/chats/${chat.id}/context`);
  expect(saved.activeRevision).toBe(2);
  expect((await read<ChatDetail>(request, `/chats/${chat.id}`)).runs).toEqual([]);
  expect(await read<unknown[]>(request, `/chats/${chat.id}/attempts`)).toEqual([]);
  await page.reload();
  await openChatSettings(page);
  await selectChatSettingsSection(page, '기억과 메모');
  await expect(panel.getByTestId('context-summary-text')).toHaveText(
    '두 번째 요약: 배가 출발했다.'
  );
});

const width = 412;
test(`CTXUI04 composer compaction keeps the draft and sends one-time priorities ${width}`, async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width, height: 900 });
  const { chat } = await create(page, `CTXUI04 ${width}`);
  await page
    .getByRole('dialog', { name: '채팅 설정', exact: true })
    .getByRole('button', { name: '채팅 설정 닫기', exact: true })
    .click();
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('다음 장면 초안');
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '컨텍스트 압축', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '컨텍스트 압축', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByText('이번 요약에서 우선할 내용 (선택)', { exact: true }).click();
  const priorities = dialog.getByLabel('압축 우선순위', { exact: true });
  await priorities.fill('미라가 아직 모르는 사실과 인물 호칭을 유지해요.');
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/context/compact`) &&
      response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: '컨텍스트 압축', exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON().priorities).toBe(
    '미라가 아직 모르는 사실과 인물 호칭을 유지해요.'
  );
  await expect(dialog).toContainText('압축할 구간이 없어요.');
  await expect(priorities).toHaveValue('');
  expect((await read<Detail>(request, `/chats/${chat.id}/context`)).jobs[0].priorities).toBe(
    '미라가 아직 모르는 사실과 인물 호칭을 유지해요.'
  );
  await dialog.getByRole('button', { name: '컨텍스트 압축 닫기', exact: true }).click();
  await expect(composer).toHaveValue('다음 장면 초안');
  await expect(page.getByRole('button', { name: '입력창 더보기', exact: true })).toBeFocused();
});

preservePromptWorkspace();
