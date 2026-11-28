import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext } from './fixtures/browser-test.js';
import type {
  ModelPreset,
  ModelWorkspace,
  PromptPreset,
  PromptWorkspace,
} from '../core/product.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { visualReview } from './fixtures/visual-review.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';
import { requestFullRunResponses } from './fixtures/full-run-response.js';

test.beforeEach(({ page }) => requestFullRunResponses(page));

async function models(request: APIRequestContext): Promise<ModelWorkspace> {
  const response = await request.get('/api/model-workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}

{
  const width = DESKTOP_WIDTH;
  test(`GMUI01 ${width} global choices apply to existing and new bot chats and freeze at reservation`, async ({
    page,
    request,
  }, info) => {
    const existing = (await (
      await postFixtureChat(request, {
        data: { title: `기존 전역 설정 채팅 ${width}` },
      })
    ).json()) as Chat;
    const connectionResponse = await request.post('/api/connections', {
      data: {
        title: `GMUI ${width} 합성 연결`,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9/not-called',
        enabled: true,
      },
    });
    expect(connectionResponse.ok()).toBe(true);
    const connection = await connectionResponse.json();
    const ids: string[] = [];
    for (const suffix of ['A', 'B']) {
      const response = await request.post('/api/model-presets', {
        data: {
          title: `GMUI ${width} ${suffix}`,
          connectionId: connection.id,
          modelId: `synthetic-global-${suffix}`,
          maxOutputTokens: 1000,
          temperature: null,
        },
      });
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
    }
    const before = await models(request);
    expect(
      (
        await request.put('/api/model-workspace', {
          data: {
            expectedRevision: before.revision,
            routes: { main: null, translation: null },
            mainJudgmentEnabled: true,
            mainJudgmentThreshold: 0.9,
            helperConfirmPaidGeneration: false,
            mcpAllowDelete: false,
            translationPolicy: { judgment: { threshold: 0.9 }, maxRetries: 1, maxCalls: 16 },
          },
        })
      ).ok()
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${existing.id}`);
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '역할별 모델');
    const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
    await expect(editor.getByLabel('본문 모델', { exact: true })).toHaveValue('');
    const behaviorSummary = editor.locator('summary').filter({ hasText: /^작업 동작/ });
    const mainRefusal = editor.getByRole('region', { name: '본문 거절 감지', exact: true });
    const translationRefusal = editor.getByRole('region', {
      name: '번역 거절 감지',
      exact: true,
    });
    const mainThreshold = editor.getByLabel('본문 거절 확신 기준', { exact: true });
    await expect(behaviorSummary).toBeVisible();
    await expect(behaviorSummary).toContainText('번역 호출 한도 16회, 거절 감지 2/2');
    await expect(mainThreshold).toBeHidden();
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toBeHidden();
    await behaviorSummary.click();
    await expect(mainRefusal).toBeVisible();
    await expect(translationRefusal).toBeVisible();
    const translationLimit = editor.getByLabel('번역 작업 호출 한도', { exact: true });
    const translationContext = editor.getByLabel('번역 참고 범위', { exact: true });
    const previousSceneLimit = editor.getByLabel('이전 두 장면의 참고 토큰 한도');
    const retryProvider = editor.getByRole('switch', { name: '프로바이더가 거절하면 재시도' });
    await expect(translationLimit).toBeVisible();
    await expect(translationContext).toHaveValue('full');
    await expect(previousSceneLimit).toHaveValue('');
    await expect(retryProvider).toBeChecked();
    await expect(translationRefusal.getByLabel('번역 작업 호출 한도')).toHaveCount(0);
    await expect(mainThreshold).toHaveValue('0.9');
    const mainToggle = editor.getByRole('switch', { name: '본문 거절 감지 사용' });
    await expect(mainToggle).toBeChecked();
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toBeVisible();
    const translationToggle = editor.getByRole('switch', { name: '번역 거절 감지 사용' });
    await expect(translationToggle).toBeChecked();
    await expect(mainRefusal.getByLabel('본문 거절 확신 기준', { exact: true })).toBeVisible();
    await expect(
      translationRefusal.getByLabel('번역 거절 확신 기준', { exact: true })
    ).toBeVisible();
    const helperTimeout = editor.getByLabel('도우미 작업 제한 시간 (분)', { exact: true });
    const saveModels = editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true });
    await expect(helperTimeout).toHaveValue('60');
    await helperTimeout.fill('0');
    await expect(saveModels).toBeDisabled();
    await helperTimeout.fill('90');
    const paidConfirmation = editor.getByRole('switch', { name: '유료 생성 전에 확인' });
    await expect(paidConfirmation).not.toBeChecked();
    await paidConfirmation.check();
    const mcpDeletion = editor.getByRole('switch', { name: 'MCP에서 삭제도 확인 없이 허용' });
    await expect(mcpDeletion).not.toBeChecked();
    await mcpDeletion.check();
    await previousSceneLimit.fill('32769');
    await expect(saveModels).toBeDisabled();
    await previousSceneLimit.fill('1024');
    for (const label of ['도우미 모델', '컨텍스트 요약 모델', '채팅 제목 모델', '확장 호출 모델'])
      await expect(editor.getByLabel(label, { exact: true })).toBeVisible();
    for (const label of ['본문 모델', '번역 모델', '채팅 제목 모델', '확장 호출 모델'])
      await editor.getByLabel(label, { exact: true }).selectOption(ids[0]);
    await editor.getByLabel('번역 자동 재요청 횟수').fill('2');
    await translationLimit.fill('12');
    await translationContext.selectOption('source-only');
    await expect(previousSceneLimit).toHaveCount(0);
    await mainThreshold.fill('0.8');
    await editor.getByLabel('번역 거절 확신 기준', { exact: true }).fill('0.85');
    await mainToggle.uncheck();
    await translationToggle.uncheck();
    await expect(retryProvider).toBeChecked();
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect.poll(async () => (await models(request)).routes.main?.id).toBe(ids[0]);
    const selected = await models(request);
    expect(selected.helperTaskTimeoutMinutes).toBe(90);
    expect(selected.helperConfirmPaidGeneration).toBe(true);
    expect(selected.mcpAllowDelete).toBe(true);
    expect(selected.titleModel).toEqual({ id: ids[0] });
    expect(selected.scriptModel).toEqual({ id: ids[0] });
    expect(selected.mainJudgmentEnabled).toBe(false);
    expect(selected.mainJudgmentThreshold).toBe(0.8);
    expect(selected.translationPolicy).toEqual({
      judgment: { threshold: 0.85, enabled: false },
      contextMode: 'source-only',
      previousSceneTokens: 1024,
      retryProviderRefusal: true,
      maxRetries: 2,
      maxCalls: 12,
    });
    await page.reload();
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '역할별 모델');
    await expect(helperTimeout).toHaveValue('90');
    await expect(paidConfirmation).toBeChecked();
    await expect(mcpDeletion).toBeChecked();
    if (visualReview) {
      for (const reviewWidth of [width, MOBILE_WIDTH]) {
        await page.setViewportSize({ width: reviewWidth, height: 900 });
        await helperTimeout.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`helper-timeout-${reviewWidth}.png`) });
        await mcpDeletion.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`agent-permissions-${reviewWidth}.png`) });
      }
      await page.setViewportSize({ width, height: 900 });
    }
    await expect(mainThreshold).toBeHidden();
    await behaviorSummary.click();
    await expect(mainToggle).not.toBeChecked();
    await expect(translationToggle).not.toBeChecked();
    await expect(translationContext).toHaveValue('source-only');
    await expect(retryProvider).toBeChecked();
    await retryProvider.uncheck();
    await translationContext.selectOption('full');
    await expect(previousSceneLimit).toHaveValue('1024');
    if (visualReview) {
      for (const reviewWidth of [width, MOBILE_WIDTH]) {
        await page.setViewportSize({ width: reviewWidth, height: 900 });
        for (const [control, name] of [
          [previousSceneLimit, 'context'],
          [retryProvider, 'refusal'],
        ] as const) {
          await control.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`translation-${name}-${reviewWidth}.png`),
          });
        }
      }
      await page.setViewportSize({ width, height: 900 });
    }
    await expect(mainThreshold).toHaveCount(0);
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toHaveCount(0);
    await mainToggle.check();
    await expect(mainThreshold).toHaveValue('0.8');
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect.poll(async () => (await models(request)).mainJudgmentEnabled).toBe(true);
    expect((await models(request)).translationPolicy.judgment.enabled).toBe(false);
    await translationToggle.check();
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toHaveValue('0.85');
    await expect(retryProvider).not.toBeChecked();
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect
      .poll(async () => (await models(request)).translationPolicy.judgment.enabled)
      .toBe(true);
    await selectSettingsSection(page, '기본 프롬프트');
    await expect(
      page.getByRole('region', { name: '기본 프롬프트 설정', exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: '기본 프롬프트 설정', exact: true })
        .getByLabel('번역 거절 판정 모델', { exact: true })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    const workspace = (await (
      await request.get('/api/prompt-workspace')
    ).json()) as PromptWorkspace;
    const promptChange = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: workspace.revision,
        main: { ...workspace.main, title: 'GMUI 현재 작문 A' },
      },
    });
    expect(promptChange.ok()).toBe(true);
    const other = (await (
      await postFixtureChat(request, {
        data: { title: `새 전역 설정 채팅 ${width}` },
      })
    ).json()) as Chat;
    expect(other.botId).not.toBe(existing.botId);
    const profileWrites: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/profile$/.test(r.url())) profileWrites.push(r.url());
    });
    const held = await request.post('/api/test/control', {
      data: { action: 'hold', barrier: 'run' },
    });
    expect(held.ok()).toBe(true);
    const reserved: Run[] = [];
    try {
      for (const chat of [existing, other]) {
        await page.goto(`/?chat=${chat.id}`);
        await page.getByLabel('다음 장면 요청', { exact: true }).fill('GMUI 예약 경계 합성 요청');
        const response = page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/chats/${chat.id}/runs`)
        );
        await page.getByRole('button', { name: '원문 생성', exact: true }).click();
        const accepted = await response;
        expect(accepted.ok()).toBe(true);
        const run = (await accepted.json()) as Run;
        reserved.push(run);
        expect(run.snapshot.profile?.models.main?.id).toBe(ids[0]);
        expect(run.snapshot.profile?.promptPresets?.main?.title).toBe('GMUI 현재 작문 A');
      }
      const current = await models(request);
      expect(
        (
          await request.put('/api/model-workspace', {
            data: {
              expectedRevision: current.revision,
              routes: { ...current.routes, main: { id: ids[1] } },
              translationPolicy: current.translationPolicy,
            },
          })
        ).ok()
      ).toBe(true);
      await expect(page.getByRole('button', { name: /^현재 본문 모델:/ })).toContainText(
        `GMUI ${width} B`
      );
      for (const run of reserved) {
        const frozen = (await detail(request, run.chatId)).runs.find((r) => r.id === run.id)!;
        expect(frozen.snapshot).toEqual(run.snapshot);
        expect((await detail(request, run.chatId)).attempts).toHaveLength(0);
        expect((await request.post(`/api/runs/${run.id}/cancel`)).ok()).toBe(true);
      }
      const currentPrompt = (await (
        await request.get('/api/prompt-workspace')
      ).json()) as PromptWorkspace;
      expect(
        (
          await request.put('/api/prompt-workspace', {
            data: {
              expectedRevision: currentPrompt.revision,
              main: { ...currentPrompt.main, title: 'GMUI 현재 작문 B' },
            },
          })
        ).ok()
      ).toBe(true);
      const state = await detail(request, existing.id);
      const nextResponse = await request.post(`/api/chats/${existing.id}/runs`, {
        data: {
          request: '다음 예약',
          expectedRevision: null,
          expectedSettingsRevision: state.chat.settingsRevision,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      expect(nextResponse.ok()).toBe(true);
      const next = (await nextResponse.json()) as Run;
      reserved.push(next);
      expect(next.snapshot.profile?.models.main?.id).toBe(ids[1]);
      expect(next.snapshot.profile?.promptPresets?.main?.title).toBe('GMUI 현재 작문 B');
      expect(profileWrites).toEqual([]);
    } finally {
      for (const run of reserved) await request.post(`/api/runs/${run.id}/cancel`);
      await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    }
  });
}

{
  const width = MOBILE_WIDTH;
  test(`GMUI02 ${width} chat pins preserve drafts, follow saved presets and return to global settings`, async ({
    page,
    request,
  }) => {
    const chatResponse = await postFixtureChat(request, {
      data: { title: `채팅 고정 ${width}` },
    });
    expect(chatResponse.ok()).toBe(true);
    const chat = (await chatResponse.json()) as Chat;
    const connectionResponse = await request.post('/api/connections', {
      data: {
        title: `고정 합성 연결 ${width}`,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9/not-called',
        enabled: true,
      },
    });
    expect(connectionResponse.ok()).toBe(true);
    const connection = await connectionResponse.json();
    const modelChoices: ModelPreset[] = [];
    for (const title of ['전역 본문', '채팅 본문']) {
      const response = await request.post('/api/model-presets', {
        data: {
          title: `${title} ${width}`,
          connectionId: connection.id,
          modelId: `synthetic-pin-${modelChoices.length}`,
          maxOutputTokens: 1000,
          temperature: null,
        },
      });
      expect(response.ok()).toBe(true);
      modelChoices.push((await response.json()) as ModelPreset);
    }
    const [globalModel, pinnedModel] = modelChoices;
    const beforeModels = await models(request);
    expect(
      (
        await request.put('/api/model-workspace', {
          data: {
            expectedRevision: beforeModels.revision,
            routes: { ...beforeModels.routes, main: { id: globalModel.id } },
            translationPolicy: beforeModels.translationPolicy,
          },
        })
      ).ok()
    ).toBe(true);
    const workspace = (await (
      await request.get('/api/prompt-workspace')
    ).json()) as PromptWorkspace;
    const presetResponse = await request.post('/api/prompt-presets', {
      data: {
        title: `채팅 작문 ${width}`,
        role: 'main',
        program: workspace.main.program,
        values: workspace.main.values,
      },
    });
    expect(presetResponse.ok()).toBe(true);
    const preset = (await presetResponse.json()) as PromptPreset;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByLabel('다음 장면 요청', { exact: true });
    await composer.fill('고정 설정을 바꿔도 보존할 요청');
    await openChatSettings(page);
    const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    await selectChatSettingsSection(page, '생성 설정');
    const promptSelect = settings.getByRole('combobox', {
      name: '이 채팅의 창작 프롬프트',
      exact: true,
    });
    await expect(promptSelect).toHaveValue('');
    await promptSelect.selectOption(preset.id);
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    const discard = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(promptSelect).toHaveValue(preset.id);

    const concurrent = (await detail(request, chat.id)).profile!;
    expect(
      (
        await request.put(`/api/chats/${chat.id}/profile`, {
          data: {
            expectedRevision: concurrent.revision,
            packageAttachments: concurrent.packageAttachments,
            image: !concurrent.image,
          },
        })
      ).ok()
    ).toBe(true);
    const conflictResponse = page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().endsWith('/profile')
    );
    await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(promptSelect).toHaveValue(preset.id);
    await expect(
      settings.getByRole('alert').filter({
        hasText: '채팅 설정이 바뀌었어요. 최신 설정을 확인한 뒤 다시 저장해 주세요.',
      })
    ).toBeVisible();
    await selectChatSettingsSection(page, '사용 자료');
    await settings.getByRole('button', { name: '변경 취소', exact: true }).click();
    await selectChatSettingsSection(page, '생성 설정');
    await expect(promptSelect).toHaveValue('');
    await promptSelect.selectOption(preset.id);
    await selectChatSettingsSection(page, '생성 설정');
    const modelSelect = settings.getByRole('combobox', {
      name: '이 채팅의 본문 모델',
      exact: true,
    });
    await expect(modelSelect).toHaveValue('');
    await modelSelect.selectOption(pinnedModel.id);
    await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
    await expect
      .poll(async () => (await detail(request, chat.id)).profile?.pinned)
      .toEqual({
        mainPromptPresetId: preset.id,
        mainModel: { id: pinnedModel.id },
      });
    expect((await detail(request, chat.id)).profile?.image).toBe(!concurrent.image);
    await expect(modelSelect.locator('option:checked')).toContainText(pinnedModel.title);
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    const chip = page.getByRole('button', { name: /^현재 본문 모델:/ });
    await expect(chip).toContainText(pinnedModel.title);
    await expect(chip).toHaveAccessibleName(/이 채팅 고정/);
    await expect(composer).toHaveValue('고정 설정을 바꿔도 보존할 요청');

    const updatedPresetResponse = await request.put(`/api/prompt-presets/${preset.id}`, {
      data: {
        role: preset.role,
        program: preset.program,
        values: preset.values,
        expectedRevision: preset.revision,
        title: `채팅 작문 최신 ${width}`,
      },
    });
    expect(updatedPresetResponse.ok()).toBe(true);
    const updatedPreset = (await updatedPresetResponse.json()) as PromptPreset;
    const currentWorkspace = (await (
      await request.get('/api/prompt-workspace')
    ).json()) as PromptWorkspace;
    expect(
      (
        await request.put('/api/prompt-workspace', {
          data: {
            expectedRevision: currentWorkspace.revision,
            main: { ...currentWorkspace.main, title: `다른 기기의 전역 작문 ${width}` },
          },
        })
      ).ok()
    ).toBe(true);
    await page.reload();
    await expect(chip).toContainText(pinnedModel.title);
    await expect(chip).toHaveAttribute('title', new RegExp(updatedPreset.title));
    expect((await detail(request, chat.id)).profile?.routes.main).toEqual({ id: pinnedModel.id });

    const reserved: Run[] = [];
    expect(
      (await request.post('/api/test/control', { data: { action: 'hold', barrier: 'run' } })).ok()
    ).toBe(true);
    try {
      const response = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/chats/${chat.id}/runs`)
      );
      await page.getByRole('button', { name: '원문 생성', exact: true }).click();
      const accepted = await response;
      expect(accepted.ok()).toBe(true);
      const run = (await accepted.json()) as Run;
      reserved.push(run);
      expect(run.snapshot.profile?.models.main?.id).toBe(pinnedModel.id);
      expect(run.snapshot.profile?.promptPresets?.main?.title).toBe(updatedPreset.title);
      expect((await detail(request, chat.id)).attempts).toHaveLength(0);
      expect((await request.post(`/api/runs/${run.id}/cancel`)).ok()).toBe(true);
      const released = (await detail(request, chat.id)).runs.find(
        (item) => item.id === run.id
      )!.snapshot;
      expect(released).toMatchObject({ settled: true, history: [], request: run.request });

      expect(
        (
          await request.put(`/api/model-presets/${pinnedModel.id}`, {
            data: {
              title: pinnedModel.title,
              connectionId: pinnedModel.connectionId,
              modelId: pinnedModel.modelId,
              maxOutputTokens: pinnedModel.maxOutputTokens,
              temperature: pinnedModel.temperature,
              expectedRevision: pinnedModel.revision,
              enabled: false,
            },
          })
        ).ok()
      ).toBe(true);
      await page.reload();
      await expect(chip).toContainText('사용 불가');
      await openChatSettings(page);
      await selectChatSettingsSection(page, '생성 설정');
      await expect(modelSelect).toHaveValue(pinnedModel.id);
      await expect(settings.getByRole('alert')).toContainText('선택한 본문 모델');
      await modelSelect.selectOption('');
      await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
      await expect
        .poll(async () => (await detail(request, chat.id)).profile?.pinned?.mainModel)
        .toBe(undefined);
      await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
      await expect(chip).toHaveAccessibleName(/창작 프롬프트 이 채팅 고정/);
      await expect(chip.locator('svg')).toBeVisible();
      await expect(chip).toContainText(globalModel.title);

      expect(
        (
          await request.delete(`/api/prompt-presets/${preset.id}`, {
            data: { expectedRevision: updatedPreset.revision },
          })
        ).ok()
      ).toBe(true);
      await page.reload();
      await expect(chip).toHaveAccessibleName(/창작 프롬프트 사용 불가/);
      await composer.fill('삭제한 프리셋으로는 실행하지 않기');
      await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
      await openChatSettings(page);
      await selectChatSettingsSection(page, '생성 설정');
      await expect(promptSelect).toHaveValue(preset.id);
      await expect(settings.getByRole('alert')).toContainText('이 채팅에 지정한 창작 프롬프트');
      await promptSelect.selectOption('');
      await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
      await expect
        .poll(async () => (await detail(request, chat.id)).profile?.pinned ?? {})
        .toEqual({});
      await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
      await expect(chip).not.toHaveAccessibleName(/이 채팅 고정|프롬프트 사용 불가/);
      await expect(composer).toHaveValue('삭제한 프리셋으로는 실행하지 않기');
      const final = await detail(request, chat.id);
      expect(final.profile?.routes.main).toEqual({ id: globalModel.id });
      expect(final.runs.find((item) => item.id === run.id)?.snapshot).toEqual(released);
      expect(final.attempts).toHaveLength(0);
    } finally {
      for (const run of reserved) await request.post(`/api/runs/${run.id}/cancel`);
      await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    }
  });
}

test('JDGUI01 saves a compatible judgment connection and model through the role settings draft', async ({
  page,
  request,
}) => {
  const endpoint = await request.post('/api/connections', {
    data: {
      title: 'JDGUI01 테스트 게이트웨이',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9/v1',
      enabled: true,
    },
  });
  expect(endpoint.ok(), await endpoint.text()).toBe(true);
  const connection = await endpoint.json();
  const before = await models(request);
  const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
  const open = async () => {
    await page.goto('/');
    await navigationAction(page, '설정');
    await selectSettingsSection(page, '역할별 모델');
    await editor
      .locator('summary')
      .filter({ hasText: /^판단 프로바이더/ })
      .click();
  };
  await open();
  const provider = editor.getByLabel('판단 프로바이더', { exact: true });
  const format = editor.getByLabel('API 형식', { exact: true });
  const model = editor.getByLabel('모델 ID', { exact: true });
  const images = editor.getByRole('switch', { name: '후보 이미지 전송', exact: true });
  const save = editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true });

  await provider.selectOption('openai');
  await expect(model).toHaveValue('gpt-6-luna');
  await expect(model).toHaveAttribute('readonly', '');
  await provider.selectOption('compatible');
  await expect(save).toBeDisabled();
  await editor.getByLabel('연결', { exact: true }).selectOption(connection.id);
  await format.selectOption('typesafe-compatible');
  await expect(images).not.toBeChecked();
  await model.fill('synthetic/decision');
  await images.check();
  expect(await models(request)).toEqual(before);
  await save.click();
  const expected = {
    ...before,
    revision: before.revision + 1,
    judgment: {
      provider: 'typesafe-compatible',
      modelId: 'synthetic/decision',
      connectionId: connection.id,
      images: true,
    },
  };
  await expect.poll(() => models(request)).toEqual(expected);
  await expect(save).toBeDisabled();
  await open();
  await expect(provider).toHaveValue('compatible');
  await expect(format).toHaveValue('typesafe-compatible');
  await expect(model).toHaveValue('synthetic/decision');
  await expect(images).toBeChecked();

  const chatResponse = await postFixtureChat(request, {
    data: { title: 'JDGUI01 전역 판단 모델 확인' },
  });
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = (await chatResponse.json()) as Chat;
  await page.goto(`/?chat=${chat.id}`);
  await openChatSettings(page);
  const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await selectChatSettingsSection(page, '생성 설정');
  await expect(
    settings.getByText('TypeSafe System One (synthetic/decision)', { exact: true })
  ).toBeVisible();
  await selectChatSettingsSection(page, '이미지');
  await expect(
    settings
      .getByRole('combobox', { name: '이미지 배치 담당', exact: true })
      .locator('option[value="jev"]')
  ).toHaveText('판단 모델');
});

preservePromptWorkspace();
