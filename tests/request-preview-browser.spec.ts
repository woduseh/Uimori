import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ModelPreset, ModelWorkspace } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';
import { postFixtureChat } from './fixtures/chat.js';
import { DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { preservePromptWorkspace } from './fixtures/prompt-workspace.js';

preservePromptWorkspace();

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function prepare(request: APIRequestContext, endpoint: string) {
  const connection = await body<{ id: string }>(
    await request.post('/api/connections', {
      data: { title: 'Preview loopback', protocol: 'fixture-sse-v1', endpoint, enabled: true },
    })
  );
  const input = {
    title: `Preview writer ${randomUUID()}`,
    connectionId: connection.id,
    modelId: 'preview-writer',
    tokenizer: 'openai-o200k',
    maxOutputTokens: 1024,
    inputTokenLimit: 65536,
    temperature: null,
  };
  const model = await body<ModelPreset>(await request.post('/api/model-presets', { data: input }));
  const workspace = await body<ModelWorkspace>(await request.get('/api/model-workspace'));
  await body(
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: workspace.revision,
        routes: { ...workspace.routes, main: { id: model.id } },
        titleModel: null,
        translationPolicy: workspace.translationPolicy,
      },
    })
  );
  const chat = await body<ChatDetail['chat']>(
    await postFixtureChat(request, { data: { title: `Preview chat ${randomUUID()}` } })
  );
  return { chat, model, input };
}

test('REQUESTPREVIEW current composer settings are estimated without generation at both widths', async ({
  page,
  request,
}, info) => {
  const peer = await loopbackProvider((_wire, response) =>
    writeSse(response, [{ type: 'text_delta', delta: 'UNEXPECTED_GENERATION' }, { type: 'done' }])
  );
  try {
    const { chat, model } = await prepare(request, peer.endpoint);
    const requests: { request: string; loreContextReset?: boolean }[] = [];
    page.on('request', (entry) => {
      if (new URL(entry.url()).pathname === `/api/chats/${chat.id}/request-preview`)
        requests.push(entry.postDataJSON());
    });
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    for (const width of DEFAULT_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const draft = `미라는 등대의 불빛을 보고 어떤 약속을 떠올렸을까? ${width}`;
      await composer.fill(draft);
      await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
      await page.getByRole('button', { name: '다음 요청 미리보기', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '다음 요청 미리보기', exact: true });
      const preview = dialog.getByTestId('request-preview');
      await expect(preview).toContainText(model.title);
      await expect(preview).toContainText('65,536');
      await expect(preview).toContainText('OpenAI · o200k_base');
      await expect(preview.getByRole('meter')).toHaveCount(1);
      expect(requests.at(-1)?.request).toBe(draft);
      await page.screenshot({ path: info.outputPath(`request-preview-${width}.png`) });
      await dialog.getByRole('button', { name: '다음 요청 미리보기 닫기', exact: true }).click();
      await expect(composer).toHaveValue(draft);
      await expect(page.getByRole('button', { name: '입력창 더보기', exact: true })).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
      ).toBe(true);
    }
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('switch', { name: '다음 생성에서 조회 로어 제외', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '조회 로어 제외 해제', exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
    await page.getByRole('button', { name: '다음 요청 미리보기', exact: true }).click();
    await expect(page.getByTestId('request-preview')).toContainText('이번 요청에서 조회 로어 제외');
    expect(requests.at(-1)?.loreContextReset).toBe(true);
    expect(peer.requests).toHaveLength(0);
    const after = await body<ChatDetail>(await request.get(`/api/chats/${chat.id}`));
    expect(after.runs).toHaveLength(0);
    expect(after.sources).toHaveLength(0);
    expect(after.chat.headRevision).toBe(chat.headRevision);
    expect(after.chat.settingsRevision).toBe(chat.settingsRevision);
  } finally {
    await peer.close();
  }
});

test('REQUESTPREVIEW closing a pending preview preserves the draft and ignores its late response', async ({
  page,
  request,
}) => {
  const peer = await loopbackProvider((_wire, response) =>
    writeSse(response, [{ type: 'text_delta', delta: 'UNEXPECTED_GENERATION' }, { type: 'done' }])
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetched = () => {};
  const firstFetched = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  let held = 0;
  try {
    const { chat, model, input } = await prepare(request, peer.endpoint);
    await page.route(
      (url) => url.pathname === `/api/chats/${chat.id}/request-preview`,
      async (route) => {
        if (held++ !== 0) return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        fetched();
        await gate;
        // The browser may already have aborted the closed dialog's request.
        await route.fulfill({ response }).catch(() => {});
      }
    );
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
    const open = async () => {
      await page.getByRole('button', { name: '입력창 더보기', exact: true }).click();
      await page.getByRole('button', { name: '다음 요청 미리보기', exact: true }).click();
    };
    await composer.fill('첫 요청은 보내지 않아요.');
    await open();
    await firstFetched;
    const dialog = page.getByRole('dialog', { name: '다음 요청 미리보기', exact: true });
    await dialog.getByRole('button', { name: '다음 요청 미리보기 닫기', exact: true }).click();
    const updated = await body<ModelPreset>(
      await request.put(`/api/model-presets/${model.id}`, {
        data: { ...input, expectedRevision: model.revision, title: '새로 선택한 미리보기 모델' },
      })
    );
    const draft = '두 번째 요청만 현재 미리보기에 사용해요.';
    await composer.fill(draft);
    await open();
    await expect(dialog.getByTestId('request-preview')).toContainText(updated.title);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(dialog.getByTestId('request-preview')).not.toContainText(model.title);
    await dialog.getByRole('button', { name: '다음 요청 미리보기 닫기', exact: true }).click();
    await expect(composer).toHaveValue(draft);
    expect(peer.requests).toHaveLength(0);
  } finally {
    release();
    await peer.close();
  }
});
