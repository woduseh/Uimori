import { visualReview } from './fixtures/visual-review.js';
import {
  editLibraryContent,
  navigationAction,
  revealLibraryEditor,
  createLibraryContent,
  selectPackageSection,
} from './ui-navigation.js';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import type { PackageBehavior } from '../core/package-behavior.js';

const behavior: PackageBehavior = {
  revision: 1,
  schemaVersion: 1,
  stateSchema: {
    type: 'record',
    properties: {
      count: { type: 'number', min: 0, max: 100, integer: true },
      note: { type: 'string', maxLength: 200 },
      active: { type: 'boolean' },
      mode: { type: 'enum', values: ['quiet', 'bright'] },
      items: { type: 'list', maxItems: 5, items: { type: 'string', maxLength: 40 } },
    },
  },
  initialState: {
    count: 0,
    note: '<img src=x onerror=alert(1)>',
    active: false,
    mode: 'quiet',
    items: ['합성 항목'],
  },
  actions: [
    {
      id: 'record',
      label: '값 기록',
      inputSchema: {
        type: 'record',
        properties: {
          count: { type: 'number', min: 0, max: 100, integer: true },
          note: { type: 'string', maxLength: 200 },
          active: { type: 'boolean' },
          mode: { type: 'enum', values: ['quiet', 'bright'] },
          items: { type: 'list', maxItems: 5, items: { type: 'string', maxLength: 40 } },
        },
      },
      effects: ['count', 'note', 'active', 'mode', 'items'].map((key) => ({
        path: [key],
        value: { context: ['input', key] },
      })),
    },
  ],
  outputParsers: [],
};
async function seed(request: APIRequestContext, definition: PackageBehavior = behavior) {
  const title = `합성 동작 ${Date.now()}`;
  const pkg = {
    version: 1,
    id: 'behavior_fixture',
    revision: 1,
    title,
    description: 'Synthetic only',
    body: 'Synthetic bot',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    behavior: definition,
  } as ContentPackage;
  const added = await request.post('/api/content', {
    data: {
      kind: 'bot',
      title,
      description: 'Synthetic only',
      text: 'Synthetic bot',
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(added.ok(), await added.text()).toBe(true);
  const content = await added.json();
  const made = await request.post('/api/chats', { data: { title, botId: content.id } });
  expect(made.ok(), await made.text()).toBe(true);
  return made.json() as Promise<{ id: string }>;
}

test('BUI01 typed actions preserve drafts after CAS conflicts, block duplicate writes and render text safely at 390px', async ({
  page,
  request,
}, info) => {
  const chat = await seed(request);
  const endpoint = `/api/chats/${chat.id}/package-behaviors`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/package-behaviors/')) writes++;
  });
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '패키지 상태와 행동', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(panel.locator('img')).toHaveCount(0);
  expect(writes).toBe(0);
  const action = panel.locator('form');
  await action.getByLabel('count', { exact: true }).fill('7');
  await action.getByLabel('note', { exact: true }).fill('사용자 초안');
  await action.getByLabel('active', { exact: true }).check();
  await action.getByLabel('mode', { exact: true }).selectOption('1');
  await action.getByLabel('items · JSON', { exact: true }).fill('["첫째","둘째"]');
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached = new Promise<void>((resolve) => {
      started = resolve;
    });
  await page.route(`**${endpoint}/*/actions`, async (route) => {
    started();
    await pending;
    await route.continue();
  });
  await action.getByRole('button', { name: '값 기록', exact: true }).click();
  await reached;
  await expect(action.getByRole('button', { name: '값 기록', exact: true })).toBeDisabled();
  expect(writes).toBe(1);
  release();
  await expect(panel.getByText('상태에 반영했어요.', { exact: true })).toBeVisible();
  await page.unroute(`**${endpoint}/*/actions`);
  let snapshot = await (await request.get(endpoint)).json();
  expect(snapshot.instances[0].state).toEqual({
    count: 7,
    note: '사용자 초안',
    active: true,
    mode: 'bright',
    items: ['첫째', '둘째'],
  });
  await action.getByLabel('note', { exact: true }).fill('충돌 뒤에도 남는 초안');
  // Freeze the browser's outgoing CAS body before the competing write. SSE refreshes
  // may then update the visible snapshot without changing this in-flight command.
  await page.route(
    `**${endpoint}/*/actions`,
    async (route) => {
      const captured = route.request().postDataJSON();
      const conflict = await request.post(route.request().url(), {
        data: {
          ...captured,
          input: { ...captured.input, count: 9 },
          idempotencyKey: crypto.randomUUID(),
        },
      });
      expect(conflict.ok(), await conflict.text()).toBe(true);
      await route.continue();
    },
    { times: 1 }
  );
  await action.getByRole('button', { name: '값 기록', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('다른 요청이 먼저 반영됐어요');
  await expect(action.getByLabel('note', { exact: true })).toHaveValue('충돌 뒤에도 남는 초안');
  snapshot = await (await request.get(endpoint)).json();
  expect(snapshot.instances[0].state.count).toBe(9);
  await action.getByLabel('items · JSON', { exact: true }).fill('{broken');
  const before = writes;
  await action.getByRole('button', { name: '값 기록', exact: true }).click();
  await expect(action.getByRole('alert')).toContainText('입력값의 형식과 범위');
  expect(writes).toBe(before);
  await expect(action.getByLabel('items · JSON', { exact: true })).toHaveValue('{broken');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview) await page.screenshot({ path: info.outputPath('behavior-mobile.png') });
  expect(errors).toEqual([]);
});

test('BUI02 behavior editor validates without discarding an invalid draft or other package edits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await createLibraryContent(page);
  await revealLibraryEditor(page);
  await library.getByLabel('자료 이름', { exact: true }).fill('합성 동작 편집');
  await library.getByLabel('자료 본문', { exact: true }).fill('기존 본문 초안');
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await selectPackageSection(page, '상태와 행동');
  await fields.getByRole('button', { name: '중립 시작 예제 넣기', exact: true }).click();
  await fields.getByText('제작자용 동작 JSON 편집', { exact: true }).click();
  const json = fields.getByLabel('동작 정의 JSON', { exact: true });
  const original = await json.inputValue();
  await json.fill('{invalid');
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  await expect(fields.getByRole('alert')).toContainText(
    '마지막으로 적용한 동작과 JSON 초안은 유지'
  );
  await expect(json).toHaveValue('{invalid');
  await expect(library.getByRole('button', { name: '자료 등록', exact: true })).toBeDisabled();
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  const guard = library.getByRole('alertdialog', { name: '미저장 자료 확인', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(json).toHaveValue('{invalid');
  await selectPackageSection(page, '로어');
  await selectPackageSection(page, '상태와 행동');
  await expect(json).toHaveValue('{invalid');
  await json.fill(original);
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  await expect(
    fields.getByText('편집 내용을 적용했어요. 자료 저장으로 새 버전을 남겨 주세요.', {
      exact: true,
    })
  ).toBeVisible();
  await expect(library.getByLabel('자료 본문', { exact: true })).toHaveValue('기존 본문 초안');
});

test('BUI03 invocation methods persist, validate automatic input drafts and show model-only actions without user buttons at 390px', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const title = `합성 호출 방법 ${Date.now()}`,
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await createLibraryContent(page);
  await revealLibraryEditor(page);
  await library.getByLabel('자료 이름', { exact: true }).fill(title);
  await library.getByLabel('자료 본문', { exact: true }).fill('Synthetic invocation example.');
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await selectPackageSection(page, '상태와 행동');
  await fields.getByRole('button', { name: '중립 시작 예제 넣기', exact: true }).click();
  const methods = fields.getByRole('group', { name: '횟수 기록 호출 방법', exact: true });
  await expect(methods.getByRole('checkbox', { name: /^사용자 버튼/ })).toBeChecked();
  await methods.getByRole('checkbox', { name: /^생성 전 자동 실행/ }).check();
  await methods.getByRole('checkbox', { name: /^모델이 필요할 때 요청/ }).check();
  await expect(
    methods.getByText(
      '이 행동에 필요한 입력을 JSON으로 채워 주세요. 입력이 없는 행동은 {}를 사용해요.',
      { exact: true }
    )
  ).toBeVisible();
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  await expect(fields.getByRole('alert')).toContainText('형식을 확인해 주세요');
  const automatic = methods.getByLabel('횟수 기록 자동 실행 입력 JSON', { exact: true });
  await automatic.fill('{invalid');
  await selectPackageSection(page, '로어');
  await selectPackageSection(page, '상태와 행동');
  await expect(automatic).toHaveValue('{invalid');
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  await expect(automatic).toHaveValue('{invalid');
  await expect(library.getByRole('button', { name: '자료 등록', exact: true })).toBeDisabled();
  await automatic.fill('{"value":4}');
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  await expect(fields.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await methods.screenshot({ path: info.outputPath('behavior-method-editor-mobile.png') });
  const addedResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/content') && response.request().method() === 'POST'
  );
  await library.getByRole('button', { name: '자료 등록', exact: true }).click();
  const added = await (await addedResponse).json();
  expect(added.package.behavior.actions[0]).toMatchObject({
    triggers: ['user', 'before-turn', 'model'],
    automaticInput: { value: 4 },
  });
  await library.getByRole('button', { name: '← 서재 목록', exact: true }).click();
  await editLibraryContent(page, `${title}`);
  await selectPackageSection(page, '상태와 행동');
  await expect(methods.getByRole('checkbox', { name: /^생성 전 자동 실행/ })).toBeChecked();
  await expect(automatic).toHaveValue('{\n  "value": 4\n}');
  await methods.getByRole('checkbox', { name: /^사용자 버튼/ }).uncheck();
  await methods.getByRole('checkbox', { name: /^생성 전 자동 실행/ }).uncheck();
  await fields.getByRole('button', { name: '동작 검증 후 적용', exact: true }).click();
  const revisedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content/${added.id}`) && response.request().method() === 'PUT'
  );
  await library.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  const revised = await (await revisedResponse).json();
  expect(revised.package.behavior.actions[0].triggers).toEqual(['model']);
  expect(revised.package.behavior.actions[0]).not.toHaveProperty('automaticInput');
  const stored = await (
    await request.get(`/api/revisions/content/${revised.id}/${revised.revision}`)
  ).json();
  expect(stored.package.behavior.actions[0].triggers).toEqual(['model']);
  const made = await request.post('/api/chats', { data: { title, botId: added.id } });
  expect(made.ok(), await made.text()).toBe(true);
  const chat = await made.json();
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '패키지 상태와 행동', exact: true });
  await expect(panel.getByText('횟수 기록', { exact: true })).toBeVisible();
  await expect(panel.getByText('모델 요청', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '횟수 기록', exact: true })).toHaveCount(0);
  await expect(panel.locator('form')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await panel.screenshot({ path: info.outputPath('behavior-model-only-mobile.png') });
  expect(errors).toEqual([]);
});

test('BUI04 a pure dice action displays its stored result safely and reload does not reroll it', async ({
  page,
  request,
}, info) => {
  const note = '<img src=x onerror=alert(1)>',
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pure: PackageBehavior = {
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
    },
    initialState: { count: 0 },
    actions: [
      {
        id: 'roll',
        label: '합성 주사위',
        triggers: ['user'],
        inputSchema: {
          type: 'record',
          properties: { note: { type: 'string', maxLength: 200, label: '결과 메모' } },
        },
        draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
        effects: [],
        result: {
          op: 'object',
          args: ['주사위', { context: ['draws', 'die'] }, '메모', { context: ['input', 'note'] }],
        },
      },
    ],
    outputParsers: [],
  };
  const chat = await seed(request, pure),
    endpoint = `/api/chats/${chat.id}/package-behaviors`;
  let writes = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/package-behaviors/')) writes++;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = page.getByRole('region', { name: '패키지 상태와 행동', exact: true }),
    result = panel.getByRole('region', { name: '최근 행동 결과', exact: true });
  await expect(panel).toBeVisible();
  await expect(result).toHaveCount(0);
  await panel.getByLabel('결과 메모', { exact: true }).fill(note);
  await panel.getByRole('button', { name: '합성 주사위', exact: true }).click();
  await expect(panel.getByText('행동 결과를 계산했어요.', { exact: true })).toBeVisible();
  await expect(
    result.getByRole('heading', { name: '합성 주사위 결과', exact: true })
  ).toBeVisible();
  await expect(result.getByText(note, { exact: true })).toBeVisible();
  await expect(result.locator('img')).toHaveCount(0);
  const first = await (await request.get(endpoint)).json(),
    outcome = first.instances[0].lastAction;
  expect(outcome.actionId).toBe('roll');
  expect(outcome.trigger).toBe('user');
  expect(outcome.result.주사위).toBeGreaterThanOrEqual(1);
  expect(outcome.result.주사위).toBeLessThanOrEqual(6);
  expect(outcome.result.메모).toBe(note);
  expect(first.instances[0].state).toEqual({ count: 0 });
  expect(writes).toBe(1);
  await expect(result.getByText(String(outcome.result.주사위), { exact: true })).toBeVisible();
  await page.reload();
  await expect(result.getByText(note, { exact: true })).toBeVisible();
  await expect(result.getByText(String(outcome.result.주사위), { exact: true })).toBeVisible();
  const refreshed = await (await request.get(endpoint)).json();
  expect(refreshed.instances[0].lastAction).toEqual(outcome);
  expect(writes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  if (visualReview)
    await panel.screenshot({ path: info.outputPath('behavior-action-result-mobile.png') });
  expect(errors).toEqual([]);
});
