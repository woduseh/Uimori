import { expect, test } from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import { MOBILE_WIDTH } from './fixtures/browser-viewports.js';

test('BUPGRADEUI01 changed package definitions preserve or explicitly transform existing state', async ({
  page,
  request,
}) => {
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic-state-upgrade',
    revision: 1,
    title: '합성 상태 업데이트',
    description: '',
    body: 'Synthetic state upgrade only.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 100 } } },
      initialState: { count: 0 },
      actions: [
        {
          id: 'record',
          label: '진행 기록',
          inputSchema: { type: 'record', properties: {} },
          effects: [{ path: ['count'], value: 7 }],
        },
      ],
      outputParsers: [],
    },
  };
  const added = await request.post('/api/content', {
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
  expect(added.ok(), await added.text()).toBe(true);
  let content = (await added.json()) as Content;
  const created = await request.post('/api/chats', {
    data: { title: 'Synthetic state update', botId: content.id },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const chat = await created.json();
  const endpoint = `/api/chats/${chat.id}/package-behaviors`;
  const read = async () => (await request.get(endpoint)).json();
  const initial = await read();
  const recorded = await request.post(
    `${endpoint}/${encodeURIComponent(initial.instances[0].instanceId)}/actions`,
    {
      data: {
        actionId: 'record',
        input: {},
        expectedStateRevision: 0,
        expectedSourceHash: null,
        idempotencyKey: crypto.randomUUID(),
      },
    }
  );
  expect(recorded.ok(), await recorded.text()).toBe(true);
  async function update(next: ContentPackage) {
    const response = await request.put(`/api/content/${content.id}`, {
      data: {
        kind: content.kind,
        title: content.title,
        description: content.description,
        text: next.body,
        loading: content.loading,
        relatedIds: content.relatedIds,
        package: next,
        expectedRevision: content.revision,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    content = (await response.json()) as Content;
  }
  const changed = structuredClone(content.package!);
  changed.behavior!.actions[0].label = '새 진행 기록';
  await update(changed);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '상태 유지·변환 업데이트', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자료 상태 업데이트', exact: true });
  await expect(dialog.getByLabel('업데이트 방법')).toHaveValue('preserve');
  await dialog.getByRole('button', { name: '변경 내용 확인', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '상태 변경 비교' })).toBeVisible();
  expect((await read()).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 7 },
    status: 'stale',
  });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  expect((await read()).instances[0].status).toBe('stale');
  await page.getByRole('button', { name: '상태 유지·변환 업데이트', exact: true }).click();
  await dialog.getByRole('button', { name: '변경 내용 확인', exact: true }).click();
  await dialog.getByRole('button', { name: '확인한 상태로 업데이트', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await read()).instances[0]).toMatchObject({
    stateRevision: 2,
    state: { count: 7 },
    status: 'ready',
  });

  const transformed = structuredClone(content.package!);
  transformed.behavior = {
    revision: 2,
    schemaVersion: 2,
    stateSchema: {
      type: 'record',
      properties: {
        total: { type: 'number', min: 0, max: 100 },
        label: { type: 'string', maxLength: 20 },
      },
    },
    initialState: { total: 0, label: 'initial' },
    actions: [],
    outputParsers: [],
    migration: {
      api: 'uimori-state-action-v1',
      source:
        'return {state: {total: api.state.count, label: "v" + api.input.to.schemaVersion}, result: null};',
    },
  };
  await update(transformed);
  await page.reload();
  await page.getByRole('button', { name: '상태 유지·변환 업데이트', exact: true }).click();
  await expect(dialog.getByLabel('업데이트 방법')).toHaveValue('program');
  await dialog.getByRole('button', { name: '변경 내용 확인', exact: true }).click();
  await expect(dialog.locator('.behavior-upgrade-json').last()).toContainText('"total": 7');
  await expect(dialog.locator('.behavior-upgrade-json').last()).toContainText('"label": "v2"');
  expect((await read()).instances[0].state).toEqual({ count: 7 });
  await dialog.getByRole('button', { name: '확인한 상태로 업데이트', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const final = (await read()).instances[0];
  expect(final).toMatchObject({
    stateRevision: 3,
    state: { total: 7, label: 'v2' },
    status: 'ready',
  });
  expect(final.lastAction?.trigger).not.toBe('model');
  await expect(page.getByLabel('다음 장면 요청', { exact: true })).toBeEnabled();
});
