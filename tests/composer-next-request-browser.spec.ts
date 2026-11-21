import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import type { ChatOptionState } from '../core/chat-options.js';
import type { ModelWorkspace, PromptWorkspace } from '../core/product.js';
import type { Chat, Run } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { loopbackProvider, sse } from './fixtures/loopback-provider.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

type Writer = { finish: () => void; fail: () => void };

async function setup(request: APIRequestContext, options: { controls?: boolean } = {}) {
  let connected = (_writer: Writer) => {};
  const writer = new Promise<Writer>((resolve) => {
    connected = resolve;
  });
  let calls = 0;
  const peer = await loopbackProvider((_wire, response: ServerResponse) => {
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const end = () => {
      response.write(sse({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: null }));
      response.end(sse({ type: 'done', reason: 'stop' }));
    };
    if (calls > 1) {
      response.write(sse({ type: 'text_delta', delta: '예약한 요청으로 이어 쓴 장면.' }));
      end();
      return;
    }
    response.write(sse({ type: 'text_delta', delta: '등대 계단을 올랐다.' }));
    return new Promise<void>((done) =>
      connected({
        finish: () => {
          end();
          done();
        },
        fail: () => {
          response.destroy();
          done();
        },
      })
    );
  });
  const connection = await body<{ id: string }>(
    await request.post('/api/connections', {
      data: {
        title: `Queue writer ${randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: peer.endpoint,
        enabled: true,
      },
    })
  );
  const model = await body<{ id: string }>(
    await request.post('/api/model-presets', {
      data: {
        title: 'Queue writer',
        connectionId: connection.id,
        modelId: 'queue-writer',
        tokenizer: 'gemini-gemma4',
        inputTokenLimit: 65536,
        maxOutputTokens: 4096,
        temperature: null,
      },
    })
  );
  const models = await body<ModelWorkspace>(await request.get('/api/model-workspace'));
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
  if (options.controls) {
    const workspace = await body<PromptWorkspace>(await request.get('/api/prompt-workspace'));
    await body(
      await request.put('/api/prompt-workspace', {
        data: {
          expectedRevision: workspace.revision,
          main: {
            title: '예약 검증 프롬프트',
            program: nativePrompt('', { customPromptTemplateToggle: 'tone=문체=text' }),
            values: { tone: '기준 문체' },
          },
        },
      })
    );
  }
  const chat = await body<Chat>(
    await postFixtureChat(request, { data: { title: `Queue chat ${randomUUID()}` } })
  );
  return { peer, writer, chat };
}

async function startRun(request: APIRequestContext, chat: Chat) {
  return body<Run>(
    await request.post(`/api/chats/${chat.id}/runs`, {
      data: {
        request: '첫 장면을 써 주세요.',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    })
  );
}

const composer = (page: Page) => page.locator('#request');
async function openRunning(page: Page, chat: Chat, run: Run, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`)).toBeVisible();
}

async function nextRequestState(request: APIRequestContext, chat: Chat) {
  await body(
    await request.post(`/api/chats/${chat.id}/outline`, {
      data: {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'create',
            ref: 'episode',
            level: 'episode',
            title: '등대의 밤',
            intent: '불을 켜요.',
          },
        ],
      },
    })
  );
  const outline = await body<{ nodes: { id: string }[] }>(
    await request.get(`/api/chats/${chat.id}/outline`)
  );
  await body(
    await request.put(`/api/chats/${chat.id}/outline/focus`, {
      data: { nodeId: outline.nodes[0]!.id },
    })
  );
  const options = await body<ChatOptionState>(await request.get(`/api/chats/${chat.id}/options`));
  await body(
    await request.post(`/api/chats/${chat.id}/options/oneoff`, {
      data: {
        expectedRevision: options.revision,
        operationId: randomUUID(),
        binding: options.binding,
        values: { tone: '이번만 쓸 문체' },
      },
    })
  );
  const guide = await body<{ revision: number; config: Record<string, unknown> }>(
    await request.get(`/api/chats/${chat.id}/story-guide`)
  );
  await body(
    await request.put(`/api/chats/${chat.id}/story-guide`, {
      data: {
        expectedRevision: guide.revision,
        config: { ...guide.config, enabled: true, work: '등대지기 이야기' },
      },
    })
  );
}

test('NEXTREQ01 the composer line names what applies to the next request and opens each place', async ({
  page,
  request,
}, info) => {
  const { peer, chat } = await setup(request, { controls: true });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await expect(composer(page)).toBeVisible();
    const line = page.getByRole('group', { name: '다음 요청에 적용', exact: true });
    await expect(line).toHaveCount(0);
    await nextRequestState(request, chat);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(line).toContainText('진행 중 플롯');
    await expect(
      line.getByRole('button', { name: '등대의 밤 플롯 열기', exact: true })
    ).toBeVisible();
    await expect(line.getByRole('button', { name: '1회 옵션 예약', exact: true })).toBeVisible();
    await expect(line.getByRole('button', { name: '원작 참고', exact: true })).toBeVisible();
    expect((await line.boundingBox())!.height).toBeLessThan(48);
    await page.screenshot({ path: info.outputPath('next-request-line-1280.png') });

    await line.getByRole('button', { name: '1회 옵션 예약', exact: true }).click();
    const options = page.locator('#chat-prompt-options');
    await expect(options.getByRole('region', { name: '1회 옵션 예약', exact: true })).toBeVisible();
    await options.getByRole('button', { name: '창작 옵션 닫기', exact: true }).click();

    await line.getByRole('button', { name: '원작 참고', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    await expect(
      settings.getByRole('tab', { name: '작품 및 원작 참고', exact: true })
    ).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByRole('switch', { name: '집필 전에 원작 참고' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);

    await line.getByRole('button', { name: '등대의 밤 플롯 열기', exact: true }).click();
    await expect(page.locator('.outline-panel')).toBeVisible();
  } finally {
    await peer.close();
  }
});

test('NEXTREQ02 on a narrow screen the line collapses to a count in the activity row', async ({
  page,
  request,
}, info) => {
  const { peer, writer, chat } = await setup(request, { controls: true });
  try {
    const run = await startRun(request, chat);
    const live = await writer;
    await nextRequestState(request, chat);
    await openRunning(page, chat, run, 412);
    const row = page.locator('.composer-dock .composer-context');
    const count = row.getByRole('group').or(row.locator('.next-request-menu > summary'));
    await expect(row.locator('.next-request-summary')).toHaveText('다음 요청 3');
    await expect(row.getByTestId('activity-status')).toBeVisible();
    const centers = await row.locator(':scope > *').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.checkVisibility())
        .map((node) => node.getBoundingClientRect())
        .map((rect) => rect.top + rect.height / 2)
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath('next-request-count-412.png') });
    await count.first().click();
    const menu = row.locator('.next-request-menu .action-menu-body');
    await expect(menu.getByRole('button')).toHaveText([
      '진행 중 플롯: 회차 등대의 밤',
      '1회 옵션 예약',
      '원작 참고',
      '진행 중 플롯 해제',
    ]);
    await menu.getByRole('button', { name: '1회 옵션 예약', exact: true }).click();
    await expect(
      page.locator('#chat-prompt-options').getByRole('region', { name: '1회 옵션 예약' })
    ).toBeVisible();
    live.finish();
  } finally {
    await peer.close();
  }
});
