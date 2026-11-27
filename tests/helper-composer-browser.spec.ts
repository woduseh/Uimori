import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ChatDetail, Run } from '../core/types.js';
import type { ModelPreset } from '../core/product.js';
import {
  createHelperChat,
  openHelperPanel,
  routeSyntheticHelper,
} from './fixtures/helper-browser.js';
import { openSourceActions } from './ui-navigation.js';

test.setTimeout(60000);

async function helperModels(request: APIRequestContext) {
  const providerResponse = await request.post('/api/connections', {
    data: {
      title: `도우미 선택 합성 ${randomUUID()}`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(providerResponse.ok()).toBe(true);
  const provider = (await providerResponse.json()) as { id: string };
  const models: ModelPreset[] = [];
  for (const suffix of ['A', 'B']) {
    const response = await request.post('/api/model-presets', {
      data: {
        title: `도우미 검색 모델 ${suffix} ${randomUUID()}`,
        connectionId: provider.id,
        modelId: `helper-picker-${suffix}`,
        maxOutputTokens: 1000,
        temperature: null,
      },
    });
    expect(response.ok()).toBe(true);
    models.push((await response.json()) as ModelPreset);
  }
  return models;
}

test('HELPMODEL rejected and uncertain helper changes require an explicit reread and never replay a write', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request);
  const models = await helperModels(request);
  await routeSyntheticHelper(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page);
  let writes = 0;
  await page.route('**/api/model-workspace', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    if (writes === 1)
      return route.fulfill({
        status: 409,
        json: { code: 'MODEL_WORKSPACE_CHANGED' },
      });
    await route.fetch();
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: /^현재 도우미 모델:/ }).click();
  const picker = page.getByRole('dialog', { name: '도우미 모델 선택', exact: true });
  const choice = picker.getByRole('button', { name: new RegExp(models[0].title) });
  await choice.click();
  await expect(picker.getByRole('alert')).toBeVisible();
  await expect(choice).toBeDisabled();
  expect(writes).toBe(1);
  await picker.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(picker.getByRole('alert')).toBeVisible();
  await expect(choice).toBeDisabled();
  expect(writes).toBe(2);
  expect((await (await request.get('/api/model-workspace')).json()).helperModel).toEqual({
    id: models[0].id,
  });
  await picker.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toBe(2);
});

test('HELPMESSAGE edits in older history keep their drafts through a conflict review and a failed save, and deletions drop loaded older messages but keep task history', async ({
  page,
  request,
}) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page, 55);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await openHelperPanel(page),
    view = state.current(),
    tasksBefore = JSON.stringify(view.tasks),
    removedPair = view.messages.slice(4, 6).map((message) => message.id),
    followingStart = view.messages[6].id;
  const loadOlder = async () => {
    await panel.getByRole('button', { name: '이전 메시지 불러오기', exact: true }).click();
    await expect(panel.locator('.helper-message')).toHaveCount(110);
  };
  await loadOlder();

  const savedRequest = view.messages[0];
  const requestArticle = panel.locator(`[data-message-id="${savedRequest.id}"]`);
  const requestInput = requestArticle.getByLabel('요청 수정 내용', { exact: true });
  const requestDraft = '작성 중인 요청 초안';
  await requestArticle.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '요청 수정', exact: true }).click();
  await requestInput.fill(requestDraft);
  savedRequest.text = '다른 화면에서 저장한 요청';
  view.conversation.revision++;
  view.conversation.historyRevision = state.emit('messages.changed', {
    revision: view.conversation.revision,
    updatedMessage: { id: savedRequest.id, text: savedRequest.text },
  });
  await requestArticle.getByRole('button', { name: '입력 저장', exact: true }).click();
  const conflict = page.locator('dialog[role="alertdialog"][open]');
  await expect(conflict.getByText(savedRequest.text, { exact: true })).toBeVisible();
  const reviewedRevision = view.conversation.revision;
  await conflict.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
  await expect(requestInput).toHaveValue(requestDraft);
  expect(savedRequest.text).not.toBe(requestDraft);
  await requestArticle.getByRole('button', { name: '입력 저장', exact: true }).click();
  await expect(requestInput).toHaveCount(0);
  expect(state.messageMutations.at(-1)?.expectedRevision).toBe(reviewedRevision);
  expect(savedRequest.text).toBe(requestDraft);

  const savedAnswer = view.messages[1];
  const answerArticle = panel.locator(`[data-message-id="${savedAnswer.id}"]`);
  const answerInput = answerArticle.getByLabel('응답 수정', { exact: true });
  const answerDraft = '저장에 실패해도 남아야 할\n**응답 편집 초안**';
  await answerArticle.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '응답 수정', exact: true }).click();
  await answerInput.fill(answerDraft);
  state.failNextMessageMutation();
  await answerArticle.getByRole('button', { name: '응답 저장', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (503)');
  await expect(answerInput).toHaveValue(answerDraft);
  expect(savedAnswer.text).not.toBe(answerDraft);
  await page.reload();
  await openHelperPanel(page);
  await loadOlder();
  await answerArticle.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '응답 수정', exact: true }).click();
  await expect(answerInput).toHaveValue(answerDraft);
  await answerArticle.getByRole('button', { name: '취소', exact: true }).click();
  await expect(answerArticle.locator('.helper-prose')).toHaveText(savedAnswer.text);

  const oldAnswer = panel.locator(`[data-message-id="${removedPair[1]}"]`);
  const changed = view.messages[5];
  changed.text = '다른 화면에서 고친 이전 응답';
  view.conversation.revision++;
  view.conversation.historyRevision = state.emit('messages.changed', {
    revision: view.conversation.revision,
    updatedMessage: { id: changed.id, text: changed.text },
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(oldAnswer.locator('.helper-prose')).toHaveText(changed.text);
  await oldAnswer.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '요청과 응답 삭제', exact: true }).click();
  const pairConfirmation = page.getByRole('alertdialog', { name: '요청과 응답 삭제', exact: true });
  await pairConfirmation.getByRole('button', { name: '요청과 응답 삭제', exact: true }).click();
  await expect(pairConfirmation).toBeHidden();
  for (const messageId of removedPair)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toHaveCount(0);
  await expect(panel.locator('.helper-message')).toHaveCount(108);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openHelperPanel(page);
  for (const messageId of removedPair)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toHaveCount(0);
  const oldRequest = panel.locator(`[data-message-id="${followingStart}"]`);
  await oldRequest.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '여기부터 삭제', exact: true }).click();
  const followingConfirmation = page.getByRole('alertdialog', {
    name: '여기부터 삭제',
    exact: true,
  });
  await followingConfirmation.getByRole('button', { name: '여기부터 삭제', exact: true }).click();
  await expect(followingConfirmation).toBeHidden();
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await expect(panel.getByTestId('source-request')).toHaveText([requestDraft, '합성 요청 2']);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openHelperPanel(page);
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await page.reload();
  await openHelperPanel(page);
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.getByTestId('helper-task-record')).toHaveCount(50);
  expect(JSON.stringify(view.tasks)).toBe(tasksBefore);
  expect(state.messageMutations.map(({ method, scope }) => ({ method, scope }))).toEqual([
    { method: 'PATCH' },
    { method: 'PATCH' },
    { method: 'PATCH' },
    { method: 'DELETE', scope: 'pair' },
    { method: 'DELETE', scope: 'following' },
  ]);
  expect(state.posts).toHaveLength(0);
});

test('HELPUI04 selected source is frozen in the request', async ({ page, request }) => {
  const chat = await createHelperChat(request),
    state = await routeSyntheticHelper(page);
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: {
          ...chat.settings,
          expectedSettingsRevision: chat.settingsRevision,
        },
      })
    ).ok()
  ).toBe(true);
  const before = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '합성 항구의 종이 울린다.',
      expectedRevision: null,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const run = (await created.json()) as Run;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).runs.find(
          (value) => value.id === run.id
        )?.status
    )
    .toBe('completed');
  const saved = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const selectedText =
    '선택의 시작\n' + '길게 이어지는 선택 원문이에요.\n'.repeat(7000) + '선택의 끝';
  expect(selectedText.length).toBeGreaterThan(123_162);
  const edited = await request.put(`/api/sources/${saved.sources[0].id}/text`, {
    data: { text: selectedText, expectedRevision: saved.sources[0].editRevision ?? 0 },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const source = (await edited.json()) as ChatDetail['sources'][number];
  const selectedSources = (
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail
  ).sources;
  await page.goto(`/?chat=${chat.id}`);
  const article = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await page.evaluate((chatId) => {
    const scope = { kind: 'chat', chatId };
    localStorage.setItem(
      `uimori:helper-session-scope:${JSON.stringify(scope)}`,
      'deleted-helper-session'
    );
  }, chat.id);
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('선택한 원문을 검토해 주세요.');
  await expect(
    panel.getByText(`선택한 원문: ${selectedText.length.toLocaleString()}자`, { exact: true })
  ).toBeVisible();
  const customRequest = '선택한 원문 전체에서 마지막 문장이 앞부분과 모순되는지 검토해 주세요.';
  await panel.getByLabel('도우미에게 요청').fill(customRequest);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(customRequest);
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].selection).toEqual({
    sourceId: source.id,
    sourceHash: source.hash,
    text: selectedText,
  });
  expect(state.posts[0].text).toBe(customRequest);
  expect(
    ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).sources
  ).toEqual(selectedSources);
});
