import { test, expect } from '@playwright/test';
import type { PromptWorkspace } from '../core/product.js';
import type { ChatOptionState } from '../core/chat-options.js';
import type { Chat } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { visualReview } from './fixtures/visual-review.js';
import { openChatSettings, selectChatSettingsSection } from './ui-navigation.js';

preservePromptWorkspace();

for (const width of [412]) {
  test(`SETTINGSFLOW one generation save validates both forms and retries only the remaining draft at ${width}px`, async ({
    page,
    request,
  }) => {
    const created = await postFixtureChat(request, {
      data: { title: `단일 생성 설정 저장 ${width}` },
    });
    expect(created.ok()).toBe(true);
    const chat = (await created.json()) as Chat;
    const before = await (await request.get(`/api/chats/${chat.id}`)).json();
    const writes: string[] = [];
    page.on('request', (entry) => {
      if (['PUT', 'PATCH'].includes(entry.method()) && /\/(profile|settings)$/.test(entry.url()))
        writes.push(new URL(entry.url()).pathname.split('/').at(-1)!);
    });
    await page.setViewportSize({ width, height: 915 });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '생성 설정');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const save = dialog.getByRole('button', { name: '채팅 설정 저장', exact: true });
    await expect(save).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: '설정 저장', exact: true })).toHaveCount(0);
    await dialog.getByLabel('작가 노트', { exact: true }).fill('두 설정을 함께 저장하는 작가 노트');
    await dialog.getByText('고급 실행 설정', { exact: true }).click();
    const calls = dialog.getByLabel('작업당 모델 호출 한도', { exact: true });
    await calls.fill('0');
    await save.click();
    expect(
      await calls.evaluate((element: HTMLInputElement) => element.validity.rangeUnderflow)
    ).toBe(true);
    expect(writes).toEqual([]);
    const nextCalls = chat.settings.maxCalls === 16 ? 15 : 16;
    await calls.fill(String(nextCalls));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/chats/${chat.id}/settings`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await gate;
      await route.fulfill({ status: 503, json: { error: '합성 실행 설정 저장 실패' } });
    });
    try {
      await save.click();
      await expect.poll(() => writes).toEqual(['profile', 'settings']);
      await expect(save).toBeDisabled();
      await expect(save).toHaveAttribute('aria-busy', 'true');
      await expect(calls).toBeDisabled();
      await expect(dialog.getByLabel('작가 노트', { exact: true })).toBeDisabled();
      await save.evaluate((element: HTMLButtonElement) => element.click());
      expect(writes).toEqual(['profile', 'settings']);
    } finally {
      release();
    }
    await expect(
      dialog.getByRole('region', { name: '생성 설정', exact: true }).getByRole('alert')
    ).toContainText('서버 작업을 완료하지 못했어요. (503)');
    await expect(save).toBeEnabled();
    const partial = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(partial.profile.authorNote).toBe('두 설정을 함께 저장하는 작가 노트');
    expect(partial.profile.revision).toBe(before.profile.revision + 1);
    expect(partial.chat.settings).toEqual(before.chat.settings);
    await expect(calls).toHaveValue(String(nextCalls));
    await page.unroute(`**/api/chats/${chat.id}/settings`);
    await save.click();
    await expect(save).toBeDisabled();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/chats/${chat.id}`)).json()).chat.settings.maxCalls
      )
      .toBe(nextCalls);
    expect(writes).toEqual(['profile', 'settings', 'settings']);
    const saved = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(saved.profile.revision).toBe(partial.profile.revision);
    expect(saved.chat.settingsRevision).toBe(before.chat.settingsRevision + 1);
    expect(saved.runs).toHaveLength(0);
    await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

test('DECISION settings chat prompt option conflict review preserves local values until explicit reconciliation', async ({
  page,
  request,
}) => {
  const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const changed = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: before.revision,
      main: {
        title: '옵션 충돌 결정 검증',
        program: nativePrompt('', {
          customPromptTemplateToggle: 'tone=합성 문체=text\nnote=독립 메모=text',
        }),
        values: { tone: '기준 문체', note: '기준 메모' },
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const chat = await (await postFixtureChat(request, { data: { title: '옵션 결정 chat' } })).json();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  const panel = page.locator('#chat-prompt-options');
  await panel
    .locator('section[aria-label="창작 옵션 값"] .chat-option-group > summary')
    .first()
    .click();
  await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
  const field = panel.getByLabel('합성 문체', { exact: true }).first();
  await field.fill('보존할 내 문체');
  const optionWrites: Record<string, unknown>[] = [];
  const endpoint = `/api/chats/${chat.id}/options/fixed`;
  page.on('request', (entry) => {
    if (entry.method() === 'POST' && new URL(entry.url()).pathname === endpoint)
      optionWrites.push(entry.postDataJSON());
  });
  const state = (await (
    await request.get(`/api/chats/${chat.id}/options`)
  ).json()) as ChatOptionState;
  const remote = await request.post(endpoint, {
    data: {
      expectedRevision: state.revision,
      operationId: crypto.randomUUID(),
      binding: state.binding,
      values: { tone: '다른 창의 저장 문체', note: '다른 창의 독립 메모' },
    },
  });
  expect(remote.ok(), await remote.text()).toBe(true);
  const remoteRevision = ((await remote.json()) as ChatOptionState).revision;
  const save = panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true });
  const dialog = page.getByRole('alertdialog', { name: '채팅 옵션 저장본 확인', exact: true });
  {
    let failReview = true;
    await page.route(`**/api/chats/${chat.id}/options`, async (route) => {
      if (route.request().method() === 'GET' && failReview)
        return route.fulfill({ status: 503, json: { error: 'Synthetic option review failure' } });
      await route.continue();
    });
    await save.click();
    await expect(dialog.getByRole('alert')).toContainText('(503)');
    const writesBeforeRead = optionWrites.length;
    await expect(dialog.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('현재 저장본')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true })
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
    await expect(field).toHaveValue('보존할 내 문체');
    expect(optionWrites).toHaveLength(writesBeforeRead);
    failReview = false;
    await save.click();
    await expect(dialog).toBeVisible();
    expect(optionWrites).toHaveLength(writesBeforeRead);
  }
  await expect(dialog.getByLabel('현재 저장본')).toContainText('다른 창의 저장 문체');
  await expect(dialog).toHaveCSS('opacity', '1');
  if (visualReview)
    await page.screenshot({ path: test.info().outputPath('option-review-chat-412.png') });
  await expect(dialog.getByLabel('현재 저장본')).not.toContainText('보존할 내 문체');
  await dialog.getByRole('button', { name: '채팅 옵션 저장본 확인 닫기', exact: true }).click();
  await expect(field).toHaveValue('보존할 내 문체');
  await save.click();
  await expect(dialog).toBeVisible();
  await dialog.press('Escape');
  await expect(field).toHaveValue('보존할 내 문체');
  const writesBeforeReview = optionWrites.length;
  await expect(panel.getByRole('button', { name: '최신 상태 확인', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '최신 옵션 불러오기', exact: true })).toHaveCount(
    0
  );
  await save.click();
  await dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(field).toHaveValue('보존할 내 문체');
  await expect(panel.getByLabel('독립 메모', { exact: true }).first()).toHaveValue(
    '다른 창의 독립 메모'
  );
  expect(optionWrites).toHaveLength(writesBeforeReview);
  const acknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === endpoint
  );
  await save.click();
  expect((await acknowledged).ok()).toBe(true);
  await expect(save).toBeDisabled();
  const saved = await (await request.get(`/api/chats/${chat.id}/options`)).json();
  expect(saved.fixedValues).toEqual({ tone: '보존할 내 문체', note: '다른 창의 독립 메모' });
  expect(optionWrites).toHaveLength(writesBeforeReview + 1);
  expect(optionWrites.at(-1)).toMatchObject({ expectedRevision: remoteRevision });
});
