import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Attempt, ChatProfile, ModelWorkspace, PromptWorkspace } from '../core/product.js';
import type { ChatDetail, Run } from '../core/types.js';
import type { RequestContext, LastSceneLoreDetail, SceneUsageDetail } from '../core/scene-usage.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const read = async <T>(request: APIRequestContext, path: string) =>
  body<T>(await request.get(`/api${path}`));

test('SCENEDIAG a completed provider call retains token and lore receipts the reader can open', async ({
  page,
  request,
}) => {
  const scene = '미라는 항구의 푸른 등대를 바라보았다.';
  const loreTitle = '항구 등대';
  const loreText = 'SCENE_DIAGNOSTICS_LORE: The harbor lighthouse shines blue.';
  const peer = await loopbackProvider((_wire, response) =>
    writeSse(response, [
      { type: 'text_delta', delta: scene },
      { type: 'usage', inputTokens: 1234, outputTokens: 87, costUsd: null },
      { type: 'done', reason: 'stop' },
    ])
  );
  const prompts = await read<PromptWorkspace>(request, '/prompt-workspace');
  try {
    await body(
      await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: prompts.revision,
          mainJudgmentEnabled: false,
          main: {
            title: 'Synthetic scene diagnostics prompt',
            program: createDefaultRisuPrompt(
              'Write one short scene using the supplied fictional lore.'
            ),
            values: {},
          },
        },
      })
    );
    const connection = await body<{ id: string }>(
      await request.post('/api/connections', {
        data: {
          title: 'Scene diagnostics loopback',
          protocol: 'fixture-sse-v1',
          endpoint: peer.endpoint,
          enabled: true,
        },
      })
    );
    const model = await body<{ id: string; revision: number }>(
      await request.post('/api/model-presets', {
        data: {
          title: 'Scene diagnostics writer',
          connectionId: connection.id,
          modelId: 'scene-diagnostics-writer',
          tokenizer: 'gemini-gemma4',
          inputTokenLimit: 65536,
          maxOutputTokens: 1024,
          temperature: null,
        },
      })
    );
    const models = await read<ModelWorkspace>(request, '/model-workspace');
    await body(
      await request.put('/api/model-workspace', {
        data: {
          expectedRevision: models.revision,
          routes: { ...models.routes, main: { id: model.id } },
          titleModel: null,
          translationPolicy: models.translationPolicy,
        },
      })
    );
    const authored = fixtureBotInput('Scene diagnostics bot');
    authored.package = nativeContent({
      name: authored.title,
      character_book: {
        entries: [
          {
            id: 'harbor-light',
            comment: loreTitle,
            content: loreText,
            constant: true,
            enabled: true,
          },
        ],
      },
    });
    const bot = await body<{ id: string }>(await request.post('/api/content', { data: authored }));
    const chat = await body<ChatDetail['chat']>(
      await request.post('/api/chats', {
        data: { title: `Scene diagnostics ${randomUUID()}`, botId: bot.id },
      })
    );
    const persona = await body<{ id: string; revision: number }>(
      await request.post('/api/content', {
        data: {
          ...fixtureBotInput('Scene diagnostics persona'),
          kind: 'persona',
          package: nativeContent(
            { name: '호출 당시 미라', description: 'SYNTHETIC_PERSONA' },
            {},
            'persona'
          ),
        },
      })
    );
    const profile = await read<ChatProfile>(request, `/chats/${chat.id}/profile`);
    await body(
      await request.put(`/api/chats/${chat.id}/profile`, {
        data: {
          expectedRevision: profile.revision,
          image: profile.image,
          packageAttachments: [
            ...(profile.packageAttachments ?? []),
            { id: persona.id, revision: persona.revision, role: 'persona' },
          ],
        },
      })
    );
    const run = await body<Run>(
      await request.post(`/api/chats/${chat.id}/runs`, {
        data: {
          request: '미라가 등대를 바라보는 장면을 써 주세요.',
          expectedRevision: chat.headRevision,
          expectedSettingsRevision: chat.settingsRevision,
          idempotencyKey: randomUUID(),
        },
      })
    );
    await expect
      .poll(async () => (await read<Run>(request, `/runs/${run.id}`)).status)
      .toBe('completed');
    const completed = await read<ChatDetail>(request, `/chats/${chat.id}`);
    expect(completed.sources).toHaveLength(1);
    expect(completed.sources[0].text).toBe(scene);
    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0].body).toContain(loreText);
    const attempts = await read<Pick<Attempt, 'id' | 'runId' | 'role'>[]>(
      request,
      `/chats/${chat.id}/attempts`
    );
    const attempt = await read<Attempt>(
      request,
      `/attempts/${attempts.find((item) => item.runId === run.id && item.role === 'main')!.id}`
    );
    expect(attempt).toMatchObject({ inputTokens: 1234, outputTokens: 87 });
    expect(attempt.request).toMatchObject({
      detailsOmitted: true,
      requestContext: {
        inputTokenLimit: 65536,
        estimator: 'model-local-v1',
        tokenizer: 'gemini-gemma4',
        tokenizerFallback: false,
      },
      requestReceipt: {
        version: 1,
        model: {
          modelId: 'scene-diagnostics-writer',
          title: 'Scene diagnostics writer',
          presetId: model.id,
        },
        prompt: { title: 'Synthetic scene diagnostics prompt' },
        persona: { id: persona.id, revision: persona.revision, name: '호출 당시 미라' },
        summary: { status: 'absent', coveredSources: 0 },
      },
    });
    expect(attempt.request).not.toHaveProperty('body');
    expect(attempt.response).not.toHaveProperty('text');
    const context = (attempt.request as { requestContext: RequestContext }).requestContext;
    expect(context.estimatedInputTokens).toBeGreaterThan(0);
    expect(context.estimatedInputTokens).toBeLessThanOrEqual(65536);
    const included = await read<LastSceneLoreDetail>(request, `/chats/${chat.id}/last-scene-lore`);
    expect(included).toMatchObject({
      sourceRevision: completed.sources[0].id,
      attemptId: attempt.id,
      lore: {
        status: 'complete',
        entries: [{ title: loreTitle, via: 'pinned', delivery: 'full' }],
      },
    });
    expect(included.lore!.entries).toHaveLength(1);
    expect(
      await read<SceneUsageDetail>(request, `/attempts/${attempt.id}/scene-detail`)
    ).toMatchObject({ lore: included.lore, cache: null });
    await body(
      await request.put(`/api/model-presets/${model.id}`, {
        data: {
          expectedRevision: model.revision,
          title: '오늘 바꾼 모델 이름',
          connectionId: connection.id,
          modelId: 'scene-diagnostics-writer',
          tokenizer: 'gemini-gemma4',
          inputTokenLimit: 65536,
          maxOutputTokens: 1024,
          temperature: null,
        },
      })
    );

    await page.goto(`/?chat=${chat.id}`);
    const activity = page.getByTestId('turn-activity');
    const inspector = page.getByTestId('scene-inspector');
    const usage = page.getByTestId('scene-receipt');
    await expect(activity).toBeVisible();
    await activity.locator(':scope > summary').click();
    await expect(usage).toBeVisible();
    await expect(inspector.locator('.scene-inspector-numbers')).toContainText('입력 1,234');
    await expect(inspector.locator('.scene-inspector-numbers')).toContainText('출력 87');
    await expect(usage.locator('[data-row="lore"] dd')).toContainText('1건 포함');
    const head = inspector.locator('.scene-inspector-head');
    await expect(head).toContainText(/Scene diagnostics writer\s*scene-diagnostics-writer/);
    await expect(head).not.toContainText('오늘 바꾼 모델 이름');
    await expect(usage).toContainText('Synthetic scene diagnostics prompt');
    await expect(usage).toContainText('호출 당시 미라');
    await usage.getByRole('button', { name: '목록 보기', exact: true }).click();
    await expect(usage.locator('.request-lore-group').filter({ hasText: loreTitle })).toContainText(
      '고정 자료'
    );
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '마지막 장면의 로어', exact: true }).click();
    const lore = page.getByRole('dialog', { name: '마지막 장면의 로어', exact: true });
    await expect(lore.getByText(loreTitle, { exact: true })).toBeVisible();
    await expect(lore).toContainText('고정 자료');
  } finally {
    await peer.close();
    const current = await read<PromptWorkspace>(request, '/prompt-workspace');
    await body(
      await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: current.revision,
          mainJudgmentEnabled: prompts.mainJudgmentEnabled === true,
        },
      })
    );
  }
});
