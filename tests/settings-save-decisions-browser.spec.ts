import { test, expect } from '@playwright/test';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import type { ChatOptionState } from '../core/chat-options.js';
import type { BackupSettings, BackupStatus } from '../core/backups.js';
import type { Chat } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';

preservePromptWorkspace();

test('AUDIT2 acknowledged runtime save remains successful when the reader refresh fails', async ({
  page,
  request,
}, info) => {
  const created = await postFixtureChat(request, {
    data: { title: '실행 설정 저장 후 읽기 실패' },
  });
  expect(created.ok()).toBe(true);
  const chat = (await created.json()) as Chat;
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  await selectChatSettingsSection(page, '실행 옵션');
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  const calls = dialog.getByLabel('작업당 모델 호출 한도', { exact: true });
  await calls.fill('16');
  let failedReads = 0;
  const writes: unknown[] = [];
  page.on('request', (entry) => {
    if (entry.method() === 'PATCH' && entry.url().endsWith(`/chats/${chat.id}/settings`))
      writes.push(entry.postDataJSON());
  });
  await page.route(`**/api/chats/${chat.id}/reader?*`, (route) => {
    failedReads++;
    return route.fulfill({ status: 503, json: { error: 'Synthetic refresh failure.' } });
  });
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/chats/${chat.id}/settings`)
  );
  await dialog.getByRole('button', { name: '설정 저장', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog.getByRole('alert')).toContainText('실행 설정은 저장했어요.');
  await expect(dialog.getByRole('alert')).toContainText('화면을 다시 불러오지 못했어요.');
  await expect(dialog.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
  await expect(calls).toHaveValue('16');
  expect(failedReads).toBeGreaterThan(0);
  expect(writes).toHaveLength(1);
  const detail = await (await request.get(`/api/chats/${chat.id}`)).json();
  expect(detail.chat.settings.maxCalls).toBe(16);
  expect(detail.chat.settingsRevision).toBe(chat.settingsRevision + 1);
  await page.screenshot({ path: info.outputPath('runtime-accepted-refresh-failed-412.png') });
  await dialog.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('alertdialog', { name: '저장하지 않은 설정', exact: true })
  ).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

for (const width of [360, 412]) {
  test(`AUDIT2 runtime reload keeps the draft until explicit discard at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const created = await postFixtureChat(request, { data: { title: `실행 옵션 초안 ${width}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const chat = (await created.json()) as Chat;
    const original = String(chat.settings.maxCalls);
    const edited = original === '16' ? '15' : '16';
    const settingsWrites: unknown[] = [];
    page.on('request', (entry) => {
      if (
        entry.method() === 'PATCH' &&
        new URL(entry.url()).pathname === `/api/chats/${chat.id}/settings`
      )
        settingsWrites.push(entry.postDataJSON());
    });
    await page.setViewportSize({ width, height: 915 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    await openChatSettings(page);
    await selectChatSettingsSection(page, '실행 옵션');
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const calls = dialog.getByLabel('작업당 모델 호출 한도', { exact: true });
    const reload = dialog.getByRole('button', { name: '저장된 설정 다시 불러오기', exact: true });
    const confirmation = page.getByRole('alertdialog', {
      name: '실행 설정 다시 불러오기',
      exact: true,
    });
    await calls.fill(edited);
    await reload.click();
    await page.screenshot({ path: info.outputPath(`audit2-runtime-reload-${width}.png`) });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(calls).toHaveValue(edited);
    await reload.click();
    await confirmation.getByRole('button', { name: '초안 버리고 불러오기', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(calls).toHaveValue(original);
    await expect(dialog.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
    expect(settingsWrites).toEqual([]);
    const after = await (await request.get(`/api/chats/${chat.id}`)).json();
    expect(after.chat.settings).toEqual(chat.settings);
    expect(after.chat.settingsRevision).toBe(chat.settingsRevision);
  });

  test(`AUDIT2 backup save announces an acknowledged save and retains a rejected draft at ${width}px`, async ({
    page,
  }, info) => {
    let saved: BackupSettings = {
      revision: 7,
      enabled: false,
      hour: 3,
      minute: 0,
      retain: 5,
      nextRunAt: null,
    };
    const writes: unknown[] = [];
    let rejectSave = false;
    await page.route('**/api/backups', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const status: BackupStatus = {
        settings: saved,
        status: 'idle',
        lastSuccess: null,
        error: null,
        warning: null,
        backups: [],
      };
      await route.fulfill({ json: status });
    });
    await page.route('**/api/backups/settings', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      const body = route.request().postDataJSON();
      writes.push(body);
      if (rejectSave)
        return route.fulfill({ status: 503, json: { error: '합성 백업 설정 저장 실패' } });
      expect(body.expectedRevision).toBe(saved.revision);
      saved = {
        ...saved,
        enabled: body.enabled,
        hour: body.hour,
        minute: body.minute,
        retain: body.retain,
        revision: saved.revision + 1,
      };
      await route.fulfill({ json: saved });
    });
    await page.setViewportSize({ width, height: 915 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '데이터 관리');
    const panel = page.getByRole('region', { name: '자동 백업', exact: true });
    const retain = panel.getByLabel('성공본 보관 개수', { exact: true });
    const save = panel.getByRole('button', { name: '백업 설정 저장', exact: true });
    await retain.fill('6');
    const [acknowledged] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/backups/settings' &&
          response.request().method() === 'PUT'
      ),
      save.click(),
    ]);
    expect(acknowledged.ok()).toBe(true);
    await acknowledged.json();
    await expect(save).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`audit2-backup-saved-${width}.png`) });
    const notice = page.getByRole('status').filter({ hasText: '백업 설정을 저장했어요.' });
    await expect(notice).toBeVisible();
    expect(saved.retain).toBe(6);
    expect(saved.revision).toBe(8);
    expect(writes).toHaveLength(1);
    await expect(notice).toBeHidden();
    rejectSave = true;
    await retain.fill('9');
    await save.click();
    await expect(panel.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요.');
    await expect(panel.getByRole('alert')).toContainText('(503)');
    await expect(panel.getByRole('alert')).toBeInViewport({ ratio: 1 });
    await expect(retain).toHaveValue('9');
    await expect(save).toBeEnabled();
    await expect(notice).toBeHidden();
    expect(saved.retain).toBe(6);
    expect(saved.revision).toBe(8);
    expect(writes).toHaveLength(2);
    await page.screenshot({ path: info.outputPath(`audit2-backup-save-failed-${width}.png`) });
  });
}

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

test('DECISION settings role model reload requires explicit discard and keeps the draft when reading fails', async ({
  page,
  request,
}, info) => {
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
  const reload = editor.getByRole('button', { name: '최신 설정 다시 불러오기', exact: true });
  const confirmation = page.getByRole('alertdialog', {
    name: '역할별 모델 설정 다시 불러오기',
    exact: true,
  });
  await reload.click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(retries).toHaveValue(String(local));
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
      translationPolicy: { ...before.translationPolicy, maxRetries: 3 },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const saved = (await changed.json()) as ModelWorkspace;
  let failing = true;
  await page.route('**/api/model-workspace', async (route) => {
    if (route.request().method() !== 'GET' || !failing) return route.continue();
    await route.fulfill({ status: 503, json: { error: 'Synthetic model settings read failure' } });
  });
  await reload.click();
  await confirmation.getByRole('button', { name: '초안 버리고 불러오기', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('초안은 유지했어요');
  await page.screenshot({ path: info.outputPath('model-settings-reload-failed-412.png') });
  await confirmation.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(retries).toHaveValue(String(local));
  expect((await (await request.get('/api/model-workspace')).json()).revision).toBe(saved.revision);
  failing = false;
  await reload.click();
  await confirmation.getByRole('button', { name: '초안 버리고 불러오기', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(retries).toHaveValue('3');
  await expect(
    editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true })
  ).toBeDisabled();
  expect((await (await request.get('/api/model-workspace')).json()).revision).toBe(saved.revision);
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
