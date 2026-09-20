import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type {
  ModelPreset,
  ModelWorkspace,
  PromptPreset,
  PromptWorkspace,
} from '../core/product.js';
import type { Chat, ChatDetail, ReaderDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import {
  navigationAction,
  openChatSettings,
  selectChatSettingsSection,
  selectSettingsSection,
} from './ui-navigation.js';

async function models(request: APIRequestContext): Promise<ModelWorkspace> {
  const response = await request.get('/api/model-workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}

for (const width of DEFAULT_WIDTHS) {
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
            routes: { main: null, translation: null, status: null },
            mainJudgmentEnabled: true,
            mainJudgmentThreshold: 0.9,
            translationPolicy: { judgment: { threshold: 0.9 }, maxRetries: 1, maxCalls: 16 },
          },
        })
      ).ok()
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${existing.id}`);
    await page.getByRole('button', { name: /^현재 본문 모델 ·/ }).click();
    const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
    await expect(editor).toContainText('모든 채팅의 이후 요청에 적용');
    await expect(editor.getByLabel('원문 모델', { exact: true })).toHaveValue('');
    await expect(editor.getByText('핵심 작업', { exact: true })).toBeVisible();
    await expect(editor.getByLabel('도우미 모델', { exact: true })).toBeHidden();
    await expect(editor.getByLabel('문맥 요약 모델', { exact: true })).toBeHidden();
    await expect(editor.getByLabel('장면 해설 모델', { exact: true })).toBeHidden();
    await expect(editor.getByLabel('채팅 제목 모델', { exact: true })).toBeHidden();
    await expect(editor.getByLabel('확장 호출 모델', { exact: true })).toBeHidden();
    const behaviorSummary = editor.locator('summary').filter({ hasText: /^작업 동작/ });
    const mainRefusal = editor.getByRole('region', { name: '본문 서비스 거절 감지', exact: true });
    const translationRefusal = editor.getByRole('region', {
      name: '번역 서비스 거절 감지',
      exact: true,
    });
    const mainThreshold = editor.getByLabel('본문 거절 확신 기준', { exact: true });
    await expect(behaviorSummary).toBeVisible();
    await expect(behaviorSummary).toContainText('번역 16회 · 거절 감지 2/2');
    await expect(mainThreshold).toBeHidden();
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toBeHidden();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      await behaviorSummary.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`refusal-collapsed-${colorScheme}-${width}.png`),
      });
      await behaviorSummary.click();
      await expect(mainRefusal).toBeVisible();
      await expect(translationRefusal).toBeVisible();
      await mainRefusal.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`refusal-expanded-${colorScheme}-${width}.png`),
      });
      await translationRefusal.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`refusal-translation-${colorScheme}-${width}.png`),
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
      ).toBe(true);
      await behaviorSummary.click();
    }
    await behaviorSummary.click();
    const translationLimit = editor.getByLabel('번역 작업 호출 한도', { exact: true });
    await expect(translationLimit).toBeVisible();
    await expect(translationRefusal.getByLabel('번역 작업 호출 한도')).toHaveCount(0);
    await expect(mainThreshold).toHaveValue('0.9');
    const mainToggle = editor.getByRole('switch', { name: '본문 서비스 거절 감지 사용' });
    await expect(mainToggle).toBeChecked();
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toBeVisible();
    const translationToggle = editor.getByRole('switch', { name: '번역 서비스 거절 감지 사용' });
    await expect(translationToggle).toBeChecked();
    await expect(mainRefusal.getByLabel('본문 거절 확신 기준', { exact: true })).toBeVisible();
    await expect(
      translationRefusal.getByLabel('번역 거절 확신 기준', { exact: true })
    ).toBeVisible();
    await editor
      .locator('summary')
      .filter({ hasText: /^자동 작업/ })
      .click();
    for (const label of ['원문 모델', '번역 모델', '장면 해설 모델', '채팅 제목 모델'])
      await editor.getByLabel(label, { exact: true }).selectOption(ids[0]);
    await editor.getByLabel('번역 자동 재요청 횟수').fill('2');
    await translationLimit.fill('12');
    await mainThreshold.fill('0.8');
    await editor.getByLabel('번역 거절 확신 기준', { exact: true }).fill('0.85');
    await mainToggle.uncheck();
    await translationToggle.uncheck();
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect.poll(async () => (await models(request)).routes.main?.id).toBe(ids[0]);
    const selected = await models(request);
    expect(selected.titleModel).toEqual({ id: ids[0] });
    expect(selected.mainJudgmentEnabled).toBe(false);
    expect(selected.mainJudgmentThreshold).toBe(0.8);
    expect(selected.translationPolicy).toEqual({
      judgment: { threshold: 0.85, enabled: false },
      maxRetries: 2,
      maxCalls: 12,
    });
    await page.reload();
    await page.getByRole('button', { name: /^현재 본문 모델 ·/ }).click();
    await expect(mainThreshold).toBeHidden();
    await behaviorSummary.click();
    await expect(mainToggle).not.toBeChecked();
    await expect(translationToggle).not.toBeChecked();
    await expect(mainThreshold).toHaveValue('0.8');
    await expect(editor.getByLabel('번역 거절 확신 기준', { exact: true })).toHaveValue('0.85');
    await mainToggle.check();
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect.poll(async () => (await models(request)).mainJudgmentEnabled).toBe(true);
    expect((await models(request)).translationPolicy.judgment.enabled).toBe(false);
    await translationToggle.check();
    await editor.getByRole('button', { name: '역할별 모델 설정 저장', exact: true }).click();
    await expect
      .poll(async () => (await models(request)).translationPolicy.judgment.enabled)
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`global-models-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await selectSettingsSection(page, '현재 프롬프트');
    await expect(
      page.getByRole('region', { name: '현재 프롬프트 설정', exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: '현재 프롬프트 설정', exact: true })
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
      // A raw API update represents another device: no localStorage or same-page save event.
      await expect(page.getByRole('button', { name: /^현재 본문 모델 ·/ })).toContainText(
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
    // Inject only the failure projection to check recovery navigation without a provider call.
    await page.route(`**/api/chats/${existing.id}/reader?*`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as ReaderDetail;
      body.runs = [{ ...reserved[0], status: 'refused', error: 'MAIN_RESPONSE_REFUSED' }];
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/?chat=${existing.id}`);
    await page
      .getByRole('group', { name: '실패한 요청' })
      .getByRole('button', { name: '설정 확인' })
      .click();
    await expect(behaviorSummary).toBeVisible();
    await expect(mainThreshold).toBeHidden();
    await expect(page.getByLabel('번역 거절 확신 기준', { exact: true })).toBeHidden();
    await behaviorSummary.click();
    await expect(mainRefusal).toBeVisible();
    await expect(translationRefusal).toBeVisible();
    await expect(mainThreshold).toHaveValue('0.8');
    await mainRefusal.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`main-refusal-settings-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.goto(`/?chat=${other.id}`);
    await navigationAction(page, '새 채팅');
    const create = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(create.getByLabel('시작 본문 모델')).toHaveCount(0);
    await expect(create.getByLabel('시작 번역 모델')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
}

for (const width of DEFAULT_WIDTHS) {
  test(`GMUI02 ${width} chat pins preserve drafts, follow saved presets and return to global settings`, async ({
    page,
    request,
  }, info) => {
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
    await selectChatSettingsSection(page, '프롬프트·모델');
    const promptSelect = settings.getByRole('combobox', {
      name: '이 채팅의 작문 프롬프트',
      exact: true,
    });
    await expect(promptSelect).toHaveValue('');
    await promptSelect.selectOption(preset.id);
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    const discard = page.getByRole('alertdialog', { name: '미저장 채팅 설정 확인', exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
    await expect(promptSelect).toHaveValue(preset.id);

    // A second device writes while this editor has a draft. The old revision must not overwrite it.
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
    await expect(settings.getByText(/다른 요청에서 채팅 설정이 바뀌었어요/)).toBeVisible();
    await settings.getByRole('button', { name: '장착 설정 다시 불러오기', exact: true }).click();
    await expect(promptSelect).toHaveValue('');
    await promptSelect.selectOption(preset.id);
    await selectChatSettingsSection(page, '프롬프트·모델');
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
    // Pinning shows in the select itself rather than in a line repeating it underneath.
    await expect(modelSelect.locator('option:checked')).toContainText(pinnedModel.title);
    await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
    await expect(settings).toBeHidden();
    const chip = page.getByRole('button', { name: /^현재 본문 모델 ·/ });
    await expect(chip).toContainText(pinnedModel.title);
    await expect(chip).toHaveAccessibleName(/이 채팅 고정/);
    await expect(chip.locator('svg')).toBeVisible();
    expect(
      await chip.locator('span').evaluate((node, title) => {
        const text = node.firstChild;
        if (!text?.textContent?.startsWith(title)) return false;
        const name = document.createRange();
        name.setStart(text, 0);
        name.setEnd(text, title.length);
        return name.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1;
      }, pinnedModel.title)
    ).toBe(true);
    await expect(composer).toHaveValue('고정 설정을 바꿔도 보존할 요청');
    await page.screenshot({ path: info.outputPath(`chat-pins-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );

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
      await chip.click();
      await expect(modelSelect).toHaveValue(pinnedModel.id);
      await expect(settings.getByRole('alert')).toContainText('선택한 본문 모델');
      await modelSelect.selectOption('');
      await settings.getByRole('button', { name: '채팅 설정 저장', exact: true }).click();
      await expect
        .poll(async () => (await detail(request, chat.id)).profile?.pinned?.mainModel)
        .toBe(undefined);
      await settings.getByRole('button', { name: '채팅 설정 닫기', exact: true }).click();
      await expect(chip).toHaveAccessibleName(/작문 프롬프트 이 채팅 고정/);
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
      await expect(chip).toHaveAccessibleName(/작문 프롬프트 사용 불가/);
      await composer.fill('삭제한 프리셋으로는 실행하지 않기');
      await expect(page.getByRole('button', { name: '원문 생성', exact: true })).toBeDisabled();
      await chip.click();
      await expect(promptSelect).toHaveValue(preset.id);
      await expect(settings.getByRole('alert')).toContainText('고정한 작문 프리셋');
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
      expect(final.runs.find((item) => item.id === run.id)?.snapshot).toEqual(run.snapshot);
      expect(final.attempts).toHaveLength(0);
    } finally {
      for (const run of reserved) await request.post(`/api/runs/${run.id}/cancel`);
      await request.post('/api/test/control', { data: { action: 'release', barrier: 'run' } });
    }
  });
}

preservePromptWorkspace();
