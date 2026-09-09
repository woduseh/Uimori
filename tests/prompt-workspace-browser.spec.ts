import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from '@playwright/test';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import type { PromptWorkspace } from '../core/product.js';

test('PWS01 current options apply globally without changing chat profiles', async ({
  page,
  request,
}, info) => {
  const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const updated = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: before.revision,
      main: {
        title: '합성 현재 작문',
        program: {
          version: 1,
          controls: [{ id: 'tone', label: '합성 문체', type: 'text', default: '담백하게' }],
          blocks: [{ id: 'history', kind: 'history', title: 'History', from: 0, to: 'end' }],
        },
        values: {},
      },
    },
  });
  expect(updated.ok()).toBe(true);
  const chat = await (
    await postFixtureChat(request, { data: { title: '현재 프롬프트 확인' } })
  ).json();
  const profile = (await (await request.get(`/api/chats/${chat.id}`)).json()).profile;
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '모든 채팅 옵션', exact: true });
  await panel.getByLabel('합성 문체', { exact: true }).fill('간결하게');
  await panel.getByRole('button', { name: '현재 옵션 적용', exact: true }).click();
  await expect(panel.getByRole('button', { name: '현재 옵션 적용' })).toBeDisabled();
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '간결하게'
  );
  expect((await (await request.get(`/api/chats/${chat.id}`)).json()).profile).toEqual(profile);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-options.png') });
  await page.getByRole('button', { name: '창작 옵션 닫기' }).click();
  const other = await (
    await postFixtureChat(request, { data: { title: '다른 채팅 현재 옵션' } })
  ).json();
  await page.goto(`/?chat=${other.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page.getByRole('button', { name: '창작 옵션', exact: true }).click();
  await page.getByRole('tab', { name: '모든 채팅', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: '모든 채팅 옵션' }).getByLabel('합성 문체', { exact: true })
  ).toHaveValue('간결하게');
});

test('PWS02 translation policy and prompt options save in the independent workspace', async ({
  page,
  request,
}, info) => {
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 모델');
  const models = page.getByRole('region', { name: '현재 모델 설정' });
  const details = models.locator('details').filter({ hasText: '거절 감지' });
  await details.locator('summary').click();
  await models.getByLabel('번역 자동 재요청 횟수').fill('2');
  await models.getByLabel('번역 전체 호출 한도').fill('12');
  await models.getByRole('button', { name: '현재 모델 설정 저장', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/model-workspace')).json()).translationPolicy.maxCalls
    )
    .toBe(12);
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  const workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(workspace.translationPolicy).toMatchObject({ maxRetries: 2, maxCalls: 12 });
  const program = {
    ...createDefaultPromptProgram('Synthetic translation', 'translation'),
    controls: [{ id: 'tone', label: 'PWS 번역 문체', type: 'text', default: '기본 문체' }],
  };
  const created = await request.post('/api/prompt-presets', {
    data: {
      title: `PWS preset ${crypto.randomUUID()}`,
      role: 'translation',
      program,
      values: { tone: '저장 기본값' },
    },
  });
  expect(created.ok()).toBe(true);
  const preset = await created.json();
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 프롬프트');
  await editor.getByLabel('현재 프롬프트 역할').selectOption('translation');
  await editor.getByLabel('현재 프롬프트 프리셋').selectOption(preset.id);
  await expect
    .poll(
      async () => (await (await request.get('/api/prompt-workspace')).json()).translation.presetId
    )
    .toBe(preset.id);
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  const tone = editor.getByLabel('PWS 번역 문체', { exact: true });
  await expect(tone).toHaveValue('저장 기본값');
  await tone.fill('직접 수정');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/prompt-workspace')).json()).translation.values.tone
    )
    .toBe('직접 수정');
  const modified = await request.put(`/api/prompt-presets/${preset.id}`, {
    data: {
      expectedRevision: preset.revision,
      role: 'translation',
      title: preset.title + ' 수정',
      program,
      values: { tone: '새 기본값' },
    },
  });
  expect(modified.ok(), await modified.text()).toBe(true);
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 프롬프트');
  await editor.getByLabel('현재 프롬프트 역할').selectOption('translation');
  expect((await (await request.get('/api/prompt-workspace')).json()).translation.values.tone).toBe(
    '직접 수정'
  );
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  let releaseApply!: () => void, applyStarted!: () => void;
  const applyGate = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const applying = new Promise<void>((resolve) => {
    applyStarted = resolve;
  });
  await page.route(
    '**/api/prompt-workspace/apply',
    async (route) => {
      const response = await route.fetch();
      applyStarted();
      await applyGate;
      await route.fulfill({ response });
    },
    { times: 1 }
  );
  try {
    await editor.getByRole('button', { name: '최신 버전 적용', exact: true }).click();
    await applying;
    await expect(tone).toBeDisabled();
    await expect(editor.getByLabel('현재 프롬프트 프리셋')).toBeDisabled();
  } finally {
    releaseApply();
  }
  await expect(tone).toBeEnabled();
  await expect(tone).toHaveValue('새 기본값');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/prompt-workspace')).json()).translation.values.tone
    )
    .toBe('새 기본값');

  if (visualReview)
    await page.screenshot({ path: info.outputPath('prompt-workspace-translation.png') });
});

test('PWS03 failed autosaves preserve consecutive local changes and protect external revisions', async ({
  page,
  request,
}) => {
  const current = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const seeded = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: current.revision,
      main: {
        ...current.main,
        program: {
          ...createDefaultPromptProgram('Synthetic autosave'),
          controls: [
            { id: 'tone', label: 'PWS 자동 문체', type: 'text', default: '기본' },
            { id: 'detail', label: 'PWS 자동 상세', type: 'text', default: '기본' },
          ],
        },
        values: {},
      },
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '현재 프롬프트');
  const editor = page.getByRole('region', { name: '현재 프롬프트 설정' });
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  const tone = editor.getByLabel('PWS 자동 문체', { exact: true });
  const detail = editor.getByLabel('PWS 자동 상세', { exact: true });
  let releaseSave!: () => void, saveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saving = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  await page.route(
    '**/api/edit-drafts/*/save',
    async (route) => {
      const response = await route.fetch();
      saveStarted();
      await saveGate;
      await route.fulfill({ response });
    },
    { times: 1 }
  );
  try {
    await tone.fill('첫 변경');
    await saving;
    await expect(detail).toBeEnabled();
    await detail.fill('연속 변경');
    await expect(detail).toHaveValue('연속 변경');
  } finally {
    releaseSave();
  }
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values)
    .toEqual({ tone: '첫 변경', detail: '연속 변경' });
  let fail = true;
  await page.route('**/api/edit-drafts/*/save', async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: '합성 저장 실패' }),
      });
    else await route.continue();
  });
  await tone.fill('실패해도 유지');
  await expect(editor.getByRole('button', { name: '다시 저장', exact: true })).toBeVisible();
  await expect(tone).toHaveValue('실패해도 유지');
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '첫 변경'
  );
  fail = false;
  await editor.getByRole('button', { name: '다시 저장', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get('/api/prompt-workspace')).json()).main.values.tone)
    .toBe('실패해도 유지');
  fail = true;
  await tone.fill('충돌 초안');
  await expect(editor.getByRole('button', { name: '다시 저장', exact: true })).toBeVisible();
  const latest = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
  const external = await request.put('/api/prompt-workspace', {
    data: {
      expectedRevision: latest.revision,
      main: { ...latest.main, values: { ...latest.main.values, tone: '다른 창 변경' } },
    },
  });
  expect(external.ok()).toBe(true);
  fail = false;
  await editor.getByRole('button', { name: '다시 저장', exact: true }).click();
  await expect(tone).toHaveValue('충돌 초안');
  await expect(editor.getByRole('alert')).toContainText('다른 곳에서');
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '다른 창 변경'
  );
});

preservePromptWorkspace();
