import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';
import { navigationAction, selectSettingsSection } from './ui-navigation.js';

async function models(request: APIRequestContext): Promise<ModelWorkspace> {
  const response = await request.get('/api/model-workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  return (await request.get(`/api/chats/${id}`)).json();
}

for (const width of [390, 1440]) {
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
            routes: { main: null, translation: null, status: null, image: null },
            translationPolicy: { refusalModel: null, maxRetries: 1, maxCalls: 16 },
          },
        })
      ).ok()
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=${existing.id}`);
    await page.getByRole('button', { name: /^현재 본문 모델 ·/ }).click();
    const editor = page.getByRole('region', { name: '현재 모델 설정', exact: true });
    await expect(editor).toContainText('모든 채팅의 이후 요청에 적용');
    await expect(editor.getByLabel('원문 모델', { exact: true })).toHaveValue('');
    for (const label of [
      '원문 모델',
      '번역 모델',
      '번역 거절 판정 모델',
      '표시 상태 모델',
      '이미지 배치 모델',
    ])
      await editor.getByLabel(label, { exact: true }).selectOption(ids[0]);
    const policy = editor.locator('details');
    if (await policy.count()) await policy.locator('summary').click();
    await editor.getByLabel('번역 자동 재요청 횟수').fill('2');
    await editor.getByLabel('번역 전체 호출 한도').fill('12');
    await editor.getByRole('button', { name: '현재 모델 설정 저장', exact: true }).click();
    await expect.poll(async () => (await models(request)).routes.main?.id).toBe(ids[0]);
    const selected = await models(request);
    expect(selected.translationPolicy).toEqual({
      refusalModel: { id: ids[0] },
      maxRetries: 2,
      maxCalls: 12,
    });
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
    await page.goto(`/?chat=${other.id}`);
    await navigationAction(page, '새 채팅');
    const create = page.getByRole('dialog', { name: '새 채팅', exact: true });
    await expect(create.getByLabel('시작 본문 모델')).toHaveCount(0);
    await expect(create.getByLabel('시작 번역 모델')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
}

preservePromptWorkspace();
