import { test, expect } from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';

test('EXTOPUI01 user code operation is durable, exposes results on request, and wires cancellation', async ({
  page,
  request,
}) => {
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic-user-operation',
    revision: 1,
    title: '합성 자료 작업',
    description: '',
    body: 'Synthetic independent operation.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 100 } } },
      initialState: { count: 0 },
      outputParsers: [],
      actions: [
        {
          id: 'compute',
          label: '자료 계산 시작',
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: ['model.generate'],
            source:
              'let available = false; try { await api.host.call("model.generate", {prompt:"Synthetic optional request"}); available = true; } catch {} return {state:{count:api.state.count + 1},result:{available}};',
          },
        },
      ],
    },
  };
  // An authored fallback exercises the real operation/Worker/UI without any configured provider.
  // Actual model transport, grant revocation and cancellation are covered by the app tests.
  const saved = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title: pkg.title,
      description: '',
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const content = await saved.json();
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic operation UI', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const accepted = page.waitForResponse(
    (response) =>
      response.url().includes('/package-behaviors/') &&
      response.url().endsWith('/actions') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '자료 계산 시작', exact: true }).click();
  const admission = await (await accepted).json();
  const operationId = admission.operation.operationId as string;
  expect(operationId).toBeTruthy();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/chats/${chat.id}/extension-operations/${operationId}`)
          ).json()
        ).status
    )
    .toBe('completed');
  await page.goto('/');
  await page.goto(`/?chat=${chat.id}`);
  const operation = page.locator(`[data-extension-operation="${operationId}"]`);
  await expect(operation.getByText('완료 · 모델 호출 0회', { exact: true })).toBeVisible();
  const metadata = await (await request.get(`/api/chats/${chat.id}/package-behaviors`)).json();
  expect(metadata.operations[0]).toMatchObject({ id: operationId, hasResult: true });
  expect(metadata.operations[0]).not.toHaveProperty('result');
  expect(metadata.instances[0].state).toEqual({ count: 1 });
  await operation.getByRole('button', { name: '계산 결과 보기', exact: true }).click();
  await expect(operation.locator('pre')).toContainText('"available": false');
  await expect(operation.locator('pre')).toContainText('"count": 1');
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();

  // Bound projection checks only the cancel control; the real cancellation/settlement uses
  // a held HTTP peer in extension-operation-app.test.ts.
  let cancelled = false;
  let sent: unknown;
  await page.route(`**/api/chats/${chat.id}/package-behaviors*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.operations = body.operations.map((item: { id: string }) =>
      item.id === operationId
        ? { ...item, status: cancelled ? 'cancelled' : 'running', hasResult: false }
        : item
    );
    await route.fulfill({ response, json: body });
  });
  await page.route(
    `**/api/chats/${chat.id}/extension-operations/${operationId}/cancel`,
    async (route) => {
      sent = route.request().postDataJSON();
      cancelled = true;
      await route.fulfill({ json: { cancelled: true, status: 'cancelled' } });
    }
  );
  await page.reload();
  await operation.getByRole('button', { name: '자료 작업 취소', exact: true }).click();
  expect(sent).toEqual({});
  await expect(operation.getByText('취소됨 · 모델 호출 0회', { exact: true })).toBeVisible();
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
});
