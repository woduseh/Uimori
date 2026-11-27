import { visualReview } from './fixtures/visual-review.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { test, expect } from './fixtures/browser-test.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, selectSettingsSection, openHelper } from './ui-navigation.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import type { PromptWorkspace } from '../core/product.js';

test(
  'PWS01 composer options affect this chat, preserve drafts and remember group disclosure locally',
  { tag: '@smoke' },
  async ({ page, request }, info) => {
    const before = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
    const updated = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: before.revision,
        main: {
          title: '합성 현재 작문',
          program: nativePrompt('', { customPromptTemplateToggle: 'tone=합성 문체=text' }),
          values: { tone: '담백하게' },
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
    const panel = page.locator('#chat-prompt-options');
    const group = panel.locator('details.chat-option-group').first();
    await expect(group).not.toHaveAttribute('open');
    await group.locator('summary').click();
    await panel.getByRole('button', { name: '합성 문체 개별 지정', exact: true }).click();
    await panel.getByLabel('합성 문체', { exact: true }).fill('간결하게');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openHelper(page);
    await expect(page.locator('#helper-panel')).toBeVisible();
    await expect(page.locator('#chat-prompt-options')).toBeHidden();
    await page.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    await expect(page.locator('#chat-prompt-options')).toBeHidden();
    const options = page.getByRole('button', { name: '창작 옵션', exact: true });
    if (!(await options.isVisible()))
      await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await options.click();
    await expect(page.locator('#helper-panel')).toBeHidden();
    await expect(panel.getByLabel('합성 문체', { exact: true })).toHaveValue('간결하게');
    await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
    await panel.getByRole('button', { name: '채팅 고정 옵션 저장', exact: true }).click();
    await expect(panel.getByRole('button', { name: '채팅 고정 옵션 저장' })).toBeDisabled();
    expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
      '담백하게'
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
    await expect(panel.locator('details.chat-option-group').first()).toHaveAttribute('open');
    await expect(panel.locator('.chat-option-current').first()).toHaveText('담백하게');
    expect((await (await request.get(`/api/chats/${chat.id}/options`)).json()).fixedValues).toEqual(
      { tone: '간결하게' }
    );
    expect(
      (await (await request.get(`/api/chats/${other.id}/options`)).json()).fixedValues
    ).toEqual({});
  }
);

test(
  'PWS02 translation policy and prompt options save in the independent workspace',
  { tag: '@smoke' },
  async ({ page, request }, info) => {
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '역할별 모델');
    const models = page.getByRole('region', { name: '역할별 모델 설정' });
    await models
      .locator('summary')
      .filter({ hasText: /^작업 동작/ })
      .click();
    await models.getByLabel('번역 자동 재요청 횟수').fill('2');
    await models.getByLabel('번역 작업 호출 한도').fill('12');
    await models.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/model-workspace')).json()).translationPolicy.maxCalls
      )
      .toBe(12);
    const editor = page.getByRole('region', { name: '기본 프롬프트 설정' });
    const workspace = await (await request.get('/api/prompt-workspace')).json();
    expect(workspace.translationPolicy).toMatchObject({ maxRetries: 2, maxCalls: 12 });
    const program = nativePrompt(
      'Synthetic translation',
      { customPromptTemplateToggle: 'tone=PWS 번역 문체=text' },
      'translation'
    );
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
    await selectSettingsSection(page, '기본 프롬프트');
    await editor.getByLabel('기본 프롬프트 역할').selectOption('translation');
    await editor.getByLabel('기본 프롬프트', { exact: true }).selectOption(preset.id);
    await expect
      .poll(
        async () => (await (await request.get('/api/prompt-workspace')).json()).translation.presetId
      )
      .toBe(preset.id);
    await editor.locator('summary').filter({ hasText: '번역 옵션' }).click();
    await editor.locator('.prompt-option-group > summary').first().click();
    const tone = editor.getByLabel('PWS 번역 문체', { exact: true });
    await expect(tone).toHaveValue('저장 기본값');
    await tone.fill('직접 수정');
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/prompt-workspace')).json()).translation.values.tone
      )
      .toBe('직접 수정');
    await editor.getByLabel('옵션 프리셋 메뉴', { exact: true }).click();
    await editor
      .getByRole('button', { name: '현재 선택을 새 옵션 프리셋으로 저장', exact: true })
      .click();
    const combo = page.getByRole('region', {
      name: '기본 프롬프트 / 옵션 프리셋 저장',
      exact: true,
    });
    const title = `PWS 조합 ${crypto.randomUUID()}`;
    await combo.getByLabel('옵션 프리셋 이름', { exact: true }).fill(title);
    await combo.getByRole('button', { name: '옵션 프리셋 저장', exact: true }).click();
    await expect(combo).toBeHidden();
    await expect(editor.getByLabel('옵션 프리셋', { exact: true }).locator('option')).toContainText(
      [title]
    );
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
    await selectSettingsSection(page, '기본 프롬프트');
    await editor.getByLabel('기본 프롬프트 역할').selectOption('translation');
    expect(
      (await (await request.get('/api/prompt-workspace')).json()).translation.values.tone
    ).toBe('직접 수정');
    await editor.locator('summary').filter({ hasText: '번역 옵션' }).click();
    await editor.getByLabel('옵션 프리셋', { exact: true }).selectOption('default');
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
  }
);

test('PWS07 quick combinations stay in this chat and obsolete combinations can be repaired', {
  tag: '@smoke',
}, async ({ page, request }) => {
  const program = nativePrompt('조합 적용 범위 확인', {
    customPromptTemplateToggle: 'tone=문체=text\nold=이전 옵션=text',
  });
  const preset = await (
    await request.post('/api/prompt-presets', {
      data: { title: '조합 수리 검증', role: 'main', program },
    })
  ).json();
  let workspace = await (await request.get('/api/prompt-workspace')).json();
  const applied = await request.post('/api/prompt-workspace/apply', {
    data: { expectedRevision: workspace.revision, role: 'main', presetId: preset.id },
  });
  expect(applied.ok()).toBe(true);
  const combo = await (
    await request.post('/api/prompt-combinations', {
      data: {
        title: '보존할 조합',
        role: 'main',
        owner: { kind: 'preset', id: preset.id },
        expectedRevision: preset.revision,
        values: { tone: '차분하게', old: '옛 값' },
      },
    })
  ).json();
  const one = await (await postFixtureChat(request, { data: { title: '조합 첫 채팅' } })).json();
  const two = await (await postFixtureChat(request, { data: { title: '조합 둘째 채팅' } })).json();
  await page.goto(`/?chat=${one.id}`);
  await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
  await page
    .getByLabel('빠른 옵션 프리셋', { exact: true })
    .selectOption(`${combo.id}@${combo.revision}`);
  await expect
    .poll(
      async () => (await (await request.get(`/api/chats/${one.id}/options`)).json()).fixedValues
    )
    .toEqual({ tone: '차분하게', old: '옛 값' });
  expect((await (await request.get(`/api/chats/${two.id}/options`)).json()).fixedValues).toEqual(
    {}
  );
  expect((await (await request.get('/api/prompt-workspace')).json()).main.optionValues).toEqual({});
  const changed = nativePrompt('조합 적용 범위 확인 수정', {
    customPromptTemplateToggle: 'tone=문체=text\nnew=새 옵션=text',
  });
  const saved = await request.put(`/api/prompt-presets/${preset.id}`, {
    data: {
      expectedRevision: preset.revision,
      title: preset.title,
      role: 'main',
      program: changed,
    },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '기본 프롬프트');
  const editor = page.getByRole('region', { name: '기본 프롬프트 설정' });
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  await expect(
    editor.getByLabel('옵션 프리셋', { exact: true }).locator('option')
  ).not.toContainText(['보존할 조합']);
  await editor.getByLabel('옵션 프리셋 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '옵션 프리셋 관리', exact: true }).click();
  const manager = page.getByRole('region', {
    name: '기본 프롬프트 / 옵션 프리셋 관리',
    exact: true,
  });
  await expect(manager).toContainText('보존할 조합');
  await expect(manager).toContainText('적용 불가');
  await manager.getByRole('button', { name: '옵션 수정', exact: true }).click();
  await manager.locator('.prompt-option-group > summary').click();
  await expect(manager.getByLabel('문체', { exact: true })).toHaveValue('차분하게');
  await manager.getByLabel('새 옵션', { exact: true }).fill('새 지시');
  await manager.getByRole('button', { name: '옵션 프리셋 저장', exact: true }).click();
  await expect(manager.getByText('적용 불가', { exact: false })).toHaveCount(0);
  const library = await (await request.get('/api/library')).json();
  const repaired = library.promptCombinations.find((item: { id: string }) => item.id === combo.id);
  expect(repaired).toMatchObject({
    id: combo.id,
    revision: combo.revision + 1,
    values: { tone: '차분하게', new: '새 지시' },
  });
  workspace = await (await request.get('/api/prompt-workspace')).json();
  expect(workspace.main.program).toEqual(changed);
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
        program: nativePrompt('Synthetic autosave', {
          customPromptTemplateToggle: 'tone=PWS 자동 문체=text\ndetail=PWS 자동 상세=text',
        }),
        values: {},
      },
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.goto('/');
  await navigationAction(page, '설정');
  await selectSettingsSection(page, '기본 프롬프트');
  const editor = page.getByRole('region', { name: '기본 프롬프트 설정' });
  await editor.locator('summary').filter({ hasText: '창작 옵션' }).click();
  await editor.locator('.prompt-option-group > summary').first().click();
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
    '**/api/resources/save',
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
  await page.route('**/api/resources/save', async (route) => {
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
  const conflict = editor
    .getByRole('alert')
    .filter({ hasText: '저장된 자료가 변경됐어요. 현재 입력은 유지돼요.' });
  await expect(conflict).toBeVisible();
  await expect(editor.getByRole('button', { name: '다시 저장', exact: true })).toBeDisabled();
  await expect(tone).toHaveValue('충돌 초안');
  expect((await (await request.get('/api/prompt-workspace')).json()).main.values.tone).toBe(
    '다른 창 변경'
  );
});

preservePromptWorkspace();
