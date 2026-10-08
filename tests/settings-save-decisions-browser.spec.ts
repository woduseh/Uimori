import { test, expect } from '@playwright/test';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import type { ChatOptionState } from '../core/chat-options.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

preservePromptWorkspace();

test('DECISION settings role model conflict review keeps the editable draft and saved version separate', async ({
  page,
  request,
}) => {
  const before = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '역할별 모델');
  const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
  await editor
    .locator('summary')
    .filter({ hasText: /^작업 동작/ })
    .click();
  const retries = editor.getByLabel('번역 자동 재요청 횟수', { exact: true });
  const local = before.translationPolicy.maxRetries === 2 ? 1 : 2;
  await retries.fill(String(local));
  const remoteRetries = 3;
  const changed = await request.put('/api/model-workspace', {
    data: {
      expectedRevision: before.revision,
      routes: before.routes,
      mainJudgmentEnabled: before.mainJudgmentEnabled,
      mainJudgmentThreshold: before.mainJudgmentThreshold,
      titleModel: before.titleModel,
      helperModel: before.helperModel,
      contextModel: before.contextModel,
      scriptModel: before.scriptModel,
      translationPolicy: { ...before.translationPolicy, maxRetries: remoteRetries },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '역할별 모델 저장 내용 확인', exact: true });
  await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
  const row = dialog
    .getByLabel('현재 저장본')
    .locator('.settings-row')
    .filter({ hasText: '번역 자동 재요청 횟수' });
  await expect(row).toContainText(String(remoteRetries));
  await dialog.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expect(retries).toHaveValue(String(local));
  expect(
    (await (await request.get('/api/model-workspace')).json()).translationPolicy.maxRetries
  ).toBe(remoteRetries);
});

for (const scope of ['global', 'chat'] as const) {
  test(`DECISION settings ${scope} prompt option conflict review preserves local values until explicit reconciliation`, async ({
    page,
    request,
  }) => {
    const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
    const changed = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: before.revision,
        main: {
          title: '옵션 충돌 결정 검증',
          program: nativePrompt('', { customPromptTemplateToggle: 'tone=합성 문체=text' }),
          values: { tone: '기준 문체' },
        },
      },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    const workspace = (await changed.json()) as PromptWorkspace;
    const chat = await (
      await postFixtureChat(request, { data: { title: `옵션 결정 ${scope}` } })
    ).json();
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
    await page
      .getByRole('tab', { name: scope === 'global' ? '모든 채팅' : '이 채팅', exact: true })
      .click();
    const panel = page.getByRole('tabpanel', {
      name: scope === 'global' ? '모든 채팅 옵션' : '이 채팅 옵션',
      exact: true,
    });
    if (scope === 'chat')
      await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
    const field = panel.getByLabel('합성 문체', { exact: true }).first();
    await field.fill('보존할 내 문체');
    if (scope === 'global') {
      const remote = await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: workspace.revision,
          main: { ...workspace.main, values: { tone: '다른 창의 저장 문체' } },
        },
      });
      expect(remote.ok(), await remote.text()).toBe(true);
    } else {
      const state = (await (
        await request.get(`/api/chats/${chat.id}/options`)
      ).json()) as ChatOptionState;
      const remote = await request.post(`/api/chats/${chat.id}/options/fixed`, {
        data: {
          expectedRevision: state.revision,
          operationId: crypto.randomUUID(),
          binding: state.binding,
          values: { tone: '다른 창의 저장 문체' },
        },
      });
      expect(remote.ok(), await remote.text()).toBe(true);
    }
    const save = panel.getByRole('button', {
      name: scope === 'global' ? '현재 옵션 적용' : '채팅 고정 옵션 저장',
      exact: true,
    });
    await save.click();
    const dialog = page.getByRole('alertdialog', {
      name: scope === 'global' ? '프롬프트 옵션 저장 내용 확인' : '채팅 옵션 저장 내용 확인',
      exact: true,
    });
    await dialog.getByRole('button', { name: '저장본 확인', exact: true }).click();
    await expect(dialog.getByLabel('현재 저장본')).toContainText('다른 창의 저장 문체');
    await expect(dialog.getByLabel('현재 저장본')).not.toContainText('보존할 내 문체');
    await dialog.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
    await expect(field).toHaveValue('보존할 내 문체');
    // A dismissed conflict remains actionable; it cannot silently grant a newer CAS revision.
    await save.click();
    await expect(dialog).toBeVisible();
    await dialog.press('Escape');
    await expect(field).toHaveValue('보존할 내 문체');
  });
}
