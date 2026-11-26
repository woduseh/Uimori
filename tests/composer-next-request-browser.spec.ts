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
import type { Chat, ChatDetail, Run } from '../core/types.js';
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
  return { peer, writer, chat, model };
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

const runStatus = async (request: APIRequestContext, id: string) =>
  (await body<Run>(await request.get(`/api/runs/${id}`))).status;

function countSends(page: Page, chatId: string) {
  const sent: string[] = [];
  page.on('request', (item) => {
    if (item.method() === 'POST' && item.url().endsWith(`/api/chats/${chatId}/runs`))
      sent.push(item.postDataJSON().request);
  });
  return sent;
}

const composer = (page: Page) => page.locator('#request');
const queued = (page: Page) => page.locator('.composer-dock .queued-request');
const queueNotice = (page: Page) => page.locator('.composer-dock .queue-notice');

async function openRunning(page: Page, chat: Chat, run: Run, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`)).toBeVisible();
}

async function queue(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Control+Enter');
  await expect(queued(page)).toContainText(text);
  await expect(composer(page)).toHaveValue('');
}

async function expectReturned(page: Page, text: string, reason: string, sent: string[]) {
  await expect(queueNotice(page)).toContainText(reason);
  await expect(composer(page)).toHaveValue(text);
  await expect(queued(page)).toHaveCount(0);
  expect(sent).toEqual([]);
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test('QUEUE01 a request queued during a run is sent once after the run completes', async ({
  page,
  request,
}, info) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    await expect(
      queued(page).getByRole('button', { name: '예약 취소', exact: true })
    ).toBeVisible();
    await composer(page).fill('다음에 쓸 메모');
    await composer(page).press('Control+Enter');
    await expect(page.getByText('이미 예약한 요청이 있어요.', { exact: false })).toBeVisible();
    await expect(composer(page)).toHaveValue('다음에 쓸 메모');
    await page.screenshot({ path: info.outputPath('queued-request-1280.png') });
    live.finish();
    await expect.poll(() => sent).toEqual(['계속 써 주세요.']);
    await expect(queued(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue('다음에 쓸 메모');
    await expect
      .poll(async () => (await body<ChatDetail>(await request.get(`/api/chats/${chat.id}`))).runs)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ request: '계속 써 주세요.', status: 'completed' }),
        ])
      );
    await setHidden(page, true);
    await setHidden(page, false);
    await page.reload();
    await expect(composer(page)).toHaveValue('다음에 쓸 메모');
    expect(sent).toEqual(['계속 써 주세요.']);
    const detail = await body<ChatDetail>(await request.get(`/api/chats/${chat.id}`));
    expect(detail.runs.filter((item) => item.request === '계속 써 주세요.')).toHaveLength(1);
  } finally {
    await peer.close();
  }
});

test('QUEUE02 cancelling a queued request puts it back in the composer', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    await composer(page).fill('덧붙일 말');
    await queued(page).getByRole('button', { name: '예약 취소', exact: true }).click();
    await expect(queued(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue('계속 써 주세요.\n\n덧붙일 말');
    live.finish();
    await expect.poll(() => runStatus(request, run.id)).toBe('completed');
    await expect(page.locator(`[data-testid="pending-run"]`)).toHaveCount(0);
    expect(sent).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('QUEUE03 a reload restores the queued request as a draft without sending it', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    await page.reload();
    await expectReturned(page, '계속 써 주세요.', '새로고침해서', sent);
    live.finish();
    await expect.poll(() => runStatus(request, run.id)).toBe('completed');
    await expect(page.locator(`[data-testid="pending-run"]`)).toHaveCount(0);
    expect(sent).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('QUEUE05 a chat settings change while queued keeps the request as a draft', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    const current = await body<ChatDetail>(await request.get(`/api/chats/${chat.id}`));
    await body(
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: {
          ...current.chat.settings,
          maxCalls: (current.chat.settings.maxCalls ?? 8) + 1,
          expectedSettingsRevision: current.chat.settingsRevision,
        },
      })
    );
    live.finish();
    await expectReturned(page, '계속 써 주세요.', '채팅 설정이 바뀌어', sent);
  } finally {
    await peer.close();
  }
});

test('QUEUE07 a failed run keeps the queued request as a draft', async ({ page, request }) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    live.fail();
    await expect.poll(() => runStatus(request, run.id)).not.toMatch(/^(queued|running)$/);
    expect(await runStatus(request, run.id)).not.toBe('completed');
    await expectReturned(page, '계속 써 주세요.', '앞선 생성이 완료되지 않아', sent);
  } finally {
    await peer.close();
  }
});

test('QUEUE09 a send that needs confirmation is not sent automatically', async ({
  page,
  request,
}) => {
  const { peer, writer, chat } = await setup(request);
  try {
    const run = await startRun(request, chat);
    await page.route(`**/api/chats/${chat.id}/codex-content-preflight`, (route) =>
      route.fulfill({ status: 200, json: { warning: true } })
    );
    const sent = countSends(page, chat.id);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    live.finish();
    await expectReturned(page, '계속 써 주세요.', '보내기 전에 확인이 필요해', sent);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await peer.close();
  }
});

test('QUEUE10 another tab on the same chat does not send the queued request', async ({
  page,
  request,
  context,
}) => {
  const { peer, writer, chat } = await setup(request);
  const second = await context.newPage();
  try {
    const run = await startRun(request, chat);
    const sent = countSends(page, chat.id);
    const sentElsewhere = countSends(second, chat.id);
    await openRunning(second, chat, run);
    await openRunning(page, chat, run);
    const live = await writer;
    await queue(page, '계속 써 주세요.');
    await expect(composer(second)).toHaveValue('');
    live.finish();
    await expect.poll(() => sent).toEqual(['계속 써 주세요.']);
    await expect(second.locator(`[data-testid="pending-run"]`)).toHaveCount(0);
    await expect(composer(second)).toHaveValue('');
    expect(sentElsewhere).toEqual([]);
  } finally {
    await second.close();
    await peer.close();
  }
});

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
}) => {
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
